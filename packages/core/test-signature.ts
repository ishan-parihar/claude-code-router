/**
 * Test script to validate iflow signature generation
 * Run with: npx ts-node test-signature.ts
 */

import { RequestSigner, PROVIDER_SIGNATURES } from "./src/utils/signature";

// Test the signature generation
function testSignature() {
  const apiKey = "test-api-key-12345";
  const signer = new RequestSigner(apiKey, PROVIDER_SIGNATURES.iflow);

  // Test headers matching iflow-cli format
  const headers = {
    "user-agent": "iFlow-Cli",
    "session-id": "test-session-abc123",
    "content-type": "application/json",
  };

  console.log("=== Testing iflow Signature Generation ===\n");

  // Sign the request
  const signedHeaders = signer.sign(headers, {});

  console.log("Input Headers:");
  console.log(JSON.stringify(headers, null, 2));

  console.log("\nSigned Headers:");
  console.log(JSON.stringify(signedHeaders, null, 2));

  // Extract timestamp and signature
  const timestamp = signedHeaders["x-iflow-timestamp"];
  const signature = signedHeaders["x-iflow-signature"];

  console.log("\n=== Signature Details ===");
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Signature: ${signature}`);

  // Verify the signature format matches iflow-cli expectations
  // Expected data format: "iFlow-Cli:test-session-abc123:<timestamp>"
  const expectedData = `iFlow-Cli:test-session-abc123:${timestamp}`;
  console.log(`\nExpected data string: ${expectedData}`);

  // Verify the signature
  const isValid = signer.verify(signedHeaders, {}, timestamp, signature);
  console.log(`\nSignature verification: ${isValid ? "VALID ✓" : "INVALID ✗"}`);

  // Test with empty session (should still work)
  console.log("\n=== Testing with empty session ===");
  const headersNoSession = {
    "user-agent": "iFlow-Cli",
    "content-type": "application/json",
  };
  const signedNoSession = signer.sign(headersNoSession, {});
  console.log("Signed headers (no session):");
  console.log(JSON.stringify(signedNoSession, null, 2));

  const tsNoSession = signedNoSession["x-iflow-timestamp"];
  const sigNoSession = signedNoSession["x-iflow-signature"];
  const expectedDataNoSession = `iFlow-Cli::${tsNoSession}`;
  console.log(`\nExpected data string: ${expectedDataNoSession}`);

  const isValidNoSession = signer.verify(
    signedNoSession,
    {},
    tsNoSession,
    sigNoSession
  );
  console.log(
    `Signature verification: ${isValidNoSession ? "VALID ✓" : "INVALID ✗"}`
  );

  console.log("\n=== All Tests Complete ===");
}

testSignature();