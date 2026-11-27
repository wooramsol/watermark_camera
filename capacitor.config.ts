import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "kr.nofakecam.app", // can still be changed before the first App Store / Play Store upload
  appName: "NoFakeCam",
  webDir: "out",
  ios: {
    contentInset: "never",
    backgroundColor: "#f8fafc",
  },
};

export default config;
