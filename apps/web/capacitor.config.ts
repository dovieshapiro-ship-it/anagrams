import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.kiwigames.anagrams",
  appName: "Anagrams",
  webDir: "dist",
  backgroundColor: "#082d20",
  ios: {
    contentInset: "always",
  },
  android: {
    backgroundColor: "#082d20",
  },
};

export default config;
