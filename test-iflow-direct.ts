/**
 * Direct test script to debug iflow 406 error
 * This mimics exactly what the CLI does
 */

import crypto from "crypto";

// Simulate the exact request the CLI makes
async function testIflowRequest() {
  const apiKey = process.argv[2] || "sk-b1c4ccfa816914e60e24b1f4d8653614";
  const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const conversationId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const timestamp = Date.now();
  
  console.log("=== Testing iflow Request ===");
  console.log("API Key:", apiKey.substring(0, 10) + "...");
  console.log("Session ID:", sessionId);
  console.log("Timestamp:", timestamp);
  
  // Build headers exactly as the code does
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Request-ID": `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
    "user-agent": "iFlow-Cli",
    "x-client-type": "iflow-cli",
    "x-client-version": "0.5.8",
    "session-id": sessionId,
    "conversation-id": conversationId,
  };
  
  // Generate signature exactly as the code does
  const data = `iFlow-Cli:${sessionId}:${timestamp}`;
  const signature = crypto.createHmac("sha256", apiKey).update(data, "utf8").digest("hex");
  
  headers["x-iflow-signature"] = signature;
  headers["x-iflow-timestamp"] = timestamp.toString();
  
  console.log("\n=== Headers ===");
  console.log(JSON.stringify(headers, null, 2));
  
  console.log("\n=== Signature Details ===");
  console.log("Data string:", data);
  console.log("Signature:", signature);
  
  // Build request body exactly as the code does
  const requestBody = {
    model: "glm-4.7",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    temperature: 1,
    top_p: 0.95
  };
  
  console.log("\n=== Request Body ===");
  console.log(JSON.stringify(requestBody, null, 2));
  
  // Make the actual request
  console.log("\n=== Making Request ===");
  try {
    const response = await fetch("https://apis.iflow.cn/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    
    console.log("Status:", response.status);
    console.log("Status Text:", response.statusText);
    
    const responseText = await response.text();
    console.log("\n=== Response ===");
    console.log(responseText);
    
    if (!response.ok) {
      console.error("\n=== ERROR ===");
      console.error(`Request failed with status ${response.status}`);
      
      // Try to parse error
      try {
        const errorJson = JSON.parse(responseText);
        console.error("Error details:", JSON.stringify(errorJson, null, 2));
      } catch {
        console.error("Raw error:", responseText);
      }
    } else {
      console.log("\n=== SUCCESS ===");
      console.log("Request succeeded!");
    }
  } catch (error) {
    console.error("\n=== FETCH ERROR ===");
    console.error(error);
  }
}

testIflowRequest();
