# Bug Report: iflow Model Provider Integration Issues

**Reporter:** CCR Integration Audit Team  
**Date:** February 10, 2026  
**Severity:** CRITICAL  
**Status:** Authentication Failures Preventing API Access

---

## Summary

The CCR (Claude Code Router) integration with the iflow API has critical authentication failures that prevent successful requests to the glm-4.7 model. The issues stem from signature algorithm mismatches and header formatting differences between the current implementation and the expected iflow-cli behavior.

---

## Critical Issues

### 1. Signature Algorithm Mismatch (CRITICAL)

**Current CCR Implementation:**
- Signature data format: `user-agentsession-idtimestampapiKey` (concatenated without separators)
- apiKey incorrectly appended to signature data

**Expected iflow-cli Format:**
- Signature data format: `user-agent:session-id:timestamp` (colon-separated)
- apiKey used ONLY as HMAC-SHA256 key, NOT in data

**Example:**
```
CCR produces:     "iFlow-Cli<session-id><timestamp><apiKey>"
iflow-cli expects: "iFlow-Cli:<session-id>:<timestamp>"
```

**Impact:** All requests fail authentication with "Unknown error" due to invalid signatures.

---

### 2. Header Casing Mismatch (CRITICAL)

CCR sends Title-Case headers while iflow expects lowercase:

| Header | CCR Sends | iflow-cli Expects |
|--------|-----------|-------------------|
| User-Agent | `User-Agent: iFlow-Cli` | `user-agent: iFlow-Cli` |
| Session ID | `X-Session-ID: <id>` | `session-id: <id>` |
| Conversation ID | `X-Conversation-ID: <id>` | `conversation-id: <id>` |

**Impact:** Signature verification fails because the server expects lowercase header values in the signature calculation.

---

### 3. Missing Session Middleware (CRITICAL)

The session middleware is defined but **not registered** in the request pipeline, resulting in:
- Empty `session-id` in signatures
- Missing conversation tracking
- Signatures formatted as: `HMAC-SHA256(apiKey, "iFlow-Cli::<timestamp>")` (missing session-id)

---

### 4. Outdated Client Version (HIGH)

- **Current:** `X-Client-Version: 0.3.26`
- **Expected:** `X-Client-Version: 0.5.8`

---

## Root Cause of "Unknown error"

The error occurs because:
1. CCR generates malformed signatures (wrong format, missing separators)
2. Session ID is empty due to unregistered middleware
3. Header casing mismatch causes server-side signature verification to fail
4. Server rejects with authentication error
5. CCR maps this to generic "Unknown error (code: unknown_error)"

---

## Required Changes

### Fix 1: Correct Signature Algorithm

Update signature generation to match iflow-cli exactly:
```typescript
// Format: "user-agent:session-id:timestamp"
const data = `${userAgent}:${sessionId}:${timestamp}`;
return crypto.createHmac("sha256", apiKey).update(data, "utf8").digest("hex");
```

### Fix 2: Use Lowercase Headers

Update all iflow-specific headers to lowercase:
- `user-agent` (not `User-Agent`)
- `session-id` (not `X-Session-ID`)
- `conversation-id` (not `X-Conversation-ID`)
- `x-client-type`, `x-client-version`

### Fix 3: Register Session Middleware

Ensure session middleware is registered in the Fastify pipeline to populate session IDs.

### Fix 4: Update Client Version

Change `X-Client-Version` from `0.3.26` to `0.5.8`.

---

## Additional Observations

### Error Handling
Consider exposing specific error codes instead of generic "Unknown error":
- `434` - Invalid API key
- `439` - Token expired
- `514` - Model error
- `429/8211/449` - Rate limit

### Model-Specific Configuration
iflow-cli applies special settings for glm-4.7:
```javascript
temperature = 1
top_p = 0.95
```

---

## Verification Checklist

After fixes are applied:
- [ ] Signature format matches `user-agent:session-id:timestamp`
- [ ] Headers are sent in lowercase
- [ ] Session ID is populated in request context
- [ ] Client version is 0.5.8
- [ ] API requests to glm-4.7 succeed
- [ ] Specific error codes are returned (not just "Unknown error")

---

## Contact

For questions or clarifications about these findings, please reach out to the CCR integration team.
