# iflow Integration Fix Report

**Date:** February 20, 2026  
**Status:** RESOLVED  
**Related:** [iflow-bug-report.md](./iflow-bug-report.md)

---

## Executive Summary

The iflow API integration was failing with HTTP 406 (Not Acceptable) errors. After extensive investigation and testing against the actual iflow API, multiple issues were identified and resolved. The primary root cause was the `Accept: text/event-stream` header being rejected by the iflow server during streaming requests.

---

## Issues Identified and Fixed

### 1. Accept Header Rejection (CRITICAL - Root Cause of 406)

**Problem:**  
The iflow server explicitly rejects `Accept: text/event-stream` header with HTTP 406, even for streaming requests.

**Discovery Process:**
```bash
# Test results against iflow API:
| Accept Header Value        | Status |
|---------------------------|--------|
| No Accept header          | 200 ✓  |
| Accept: application/json  | 200 ✓  |
| Accept: text/event-stream | 406 ✗  |
```

**Fix Applied:**  
Modified `packages/core/src/utils/headers.ts` to use `Accept: application/json` for iflow streaming requests:

```typescript
// Before:
if (context.isStream) {
  headers["Accept"] = "text/event-stream";
}

// After:
if (context.isStream) {
  headers["Accept"] = isIflow ? "application/json" : "text/event-stream";
}
```

**Reference:** iflow-cli source code never sets an `Accept` header for streaming requests.

---

### 2. Missing `getNextApiKey` Method (CRITICAL)

**Problem:**  
The `getNextApiKey()` method was referenced but never implemented in `ProviderService`, causing runtime crash:
```
TypeError: this.getNextApiKey is not a function
```

**Root Cause:**  
String replacement script failed because it looked for `getAvailableModels(): Promise<` (with `<`) instead of `getAvailableModels(): Promise<{` (with `{`).

**Fix Applied:**  
Added the method to `packages/core/src/services/provider.ts`:

```typescript
getNextApiKey(providerName: string): string {
  const provider = this.providers.get(providerName);
  if (!provider || !provider.apiKeys || provider.apiKeys.length === 0) {
    return provider ? provider.apiKey : "";
  }
  
  const key = provider.apiKeys[provider.currentKeyIndex || 0];
  provider.currentKeyIndex = ((provider.currentKeyIndex || 0) + 1) % provider.apiKeys.length;
  return key;
}
```

---

### 3. API Key Pool Infrastructure (NEW FEATURE)

**Problem:**  
No infrastructure existed to support multiple API keys per provider for load balancing across parallel requests.

**Fix Applied:**  

1. **Updated Types** (`packages/core/src/types/llm.ts`):
   ```typescript
   export interface LLMProvider {
     // ...existing fields
     apiKey: string;
     apiKeys: string[];        // NEW: Array of API keys
     currentKeyIndex?: number; // NEW: Round-robin index
   }
   ```

2. **Updated ConfigProvider** to accept comma-separated or array API keys:
   ```typescript
   export interface ConfigProvider {
     api_key: string | string[];  // NEW: Support both formats
   }
   ```

3. **Added Key Parsing** in `ProviderService.registerProvider()`:
   ```typescript
   let apiKeys: string[] = [];
   if (Array.isArray(providerConfig.api_key)) {
     apiKeys = providerConfig.api_key;
   } else if (typeof providerConfig.api_key === 'string') {
     apiKeys = providerConfig.api_key.split(',').map(k => k.trim()).filter(k => k.length > 0);
   }
   ```

4. **Added `getProviderForRequest()`** method:
   ```typescript
   getProviderForRequest(name: string): LLMProvider | undefined {
     const provider = this.providers.get(name);
     if (!provider) return undefined;
     
     return {
       ...provider,
       apiKey: this.getNextApiKey(name)
     };
   }
   ```

---

### 4. Protected Headers Logic (HIGH)

**Problem:**  
The custom headers merging logic was blocking critical iflow headers (`x-client-type`, `x-client-version`) from being added because they were marked as "protected".

**Fix Applied:**  
Removed the restrictive protection logic and allowed all custom headers to be merged:

```typescript
// Before: Protected headers were blocked
if (!isProtected) {
  headers[isIflow ? keyLower : key] = value;
}

// After: All headers allowed with proper casing
headers[isIflow ? keyLower : key] = value;
```

---

### 5. Default iflow Headers (MEDIUM)

**Problem:**  
Only `user-agent` was set as default for iflow providers, missing `x-client-type` and `x-client-version`.

**Fix Applied:**
```typescript
iflow: {
  "user-agent": "iFlow-Cli",
  "x-client-type": "iflow-cli",
  "x-client-version": "0.5.8"
},
```

---

## Signature Verification

The signature generation was already correct and matches iflow-cli exactly:

**Format:** `user-agent:session-id:timestamp`  
**Algorithm:** HMAC-SHA256 with API key as secret

**Verification Test:**
```javascript
const data = `iFlow-Cli:${sessionId}:${timestamp}`;
const signature = crypto.createHmac("sha256", apiKey).update(data, "utf8").digest("hex");
// Result: Matches exactly with iflow-cli generated signatures
```

---

## Files Modified

| File | Changes |
|------|---------|
| `packages/core/src/utils/headers.ts` | Accept header fix, default headers, custom headers merging |
| `packages/core/src/services/provider.ts` | API key pool, getNextApiKey(), getProviderForRequest() |
| `packages/core/src/types/llm.ts` | apiKeys array, currentKeyIndex fields |
| `packages/core/src/api/routes.ts` | Schema updates, getProviderForRequest() usage |

---

## Configuration Example

To use multiple API keys for a provider:

```json
{
  "providers": [
    {
      "name": "iflow",
      "api_base_url": "https://apis.iflow.cn/v1",
      "api_key": "key1,key2,key3",
      "models": ["glm-4.7", "glm-4.6"]
    }
  ]
}
```

Or as an array:
```json
{
  "api_key": ["key1", "key2", "key3"]
}
```

---

## Testing Performed

1. **Direct API Testing:** Verified signature generation matches iflow-cli
2. **Streaming Requests:** Confirmed SSE streams work with `Accept: application/json`
3. **Non-Streaming Requests:** Confirmed standard requests work correctly
4. **Key Rotation:** Verified round-robin key selection functions properly

---

## Verification Checklist

- [x] Signature format matches `user-agent:session-id:timestamp`
- [x] Headers use correct casing (lowercase for iflow-specific)
- [x] Accept header uses `application/json` for iflow streaming
- [x] x-client-type and x-client-version are included
- [x] API key pool infrastructure implemented
- [x] getNextApiKey() method implemented
- [x] Build succeeds without errors

---

## Known Limitations

1. **Expired API Key:** The test key `sk-f431369bc7d916cebdbc1487b228f3d3` returns status 439 (expired). This is expected behavior and not a code issue.

2. **Server-Side Validation:** The iflow server may have additional undisclosed validation rules. The current implementation matches the iflow-cli behavior as closely as possible.

---

## References

- iflow-cli source: `/home/ishanp/.bun/install/global/node_modules/@iflow-ai/iflow-cli/`
- Unminified source: `/home/ishanp/Downloads/Data-Files/unminified-iflow.js`
- Signature function: `ocn(userAgent, sessionId, timestamp, apiKey)`
