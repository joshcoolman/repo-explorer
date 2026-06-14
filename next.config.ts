import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the Agent SDK (which spawns a bundled binary) out of the server bundle
  // so its executable resolves from node_modules at runtime.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
