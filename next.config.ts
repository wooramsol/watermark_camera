import type { NextConfig } from "next";

// Static export: the same build is served by Vercel (web) and bundled into the iOS/Android app by Capacitor.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
