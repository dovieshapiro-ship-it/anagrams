import { spawn } from "node:child_process";
import { networkInterfaces, userInfo } from "node:os";

const webPort = 3000;
const apiPort = 3001;

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function findLanAddress() {
  if (process.env.MOBILE_HOST) return process.env.MOBILE_HOST;

  const candidates = Object.entries(networkInterfaces()).flatMap(
    ([name, addresses]) =>
      (addresses ?? [])
        .filter(
          (entry) =>
            entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address),
        )
        .map((entry) => ({ name, address: entry.address })),
  );

  candidates.sort((a, b) => {
    const priority = (name) => (name === "en0" ? 0 : name === "en1" ? 1 : 2);
    return priority(a.name) - priority(b.name);
  });

  return candidates[0]?.address;
}

const lanAddress = findLanAddress();

if (!lanAddress) {
  console.error(
    "Could not find a private Wi-Fi address. Connect the Mac to Wi-Fi, or run with MOBILE_HOST set to the Mac's local IP address.",
  );
  process.exit(1);
}

const phoneUrl = `http://${lanAddress}:${webPort}`;
const localUrl = `http://localhost:${webPort}`;
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/anagrams_test`;

const sharedEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  HOST: "0.0.0.0",
  PORT: String(apiPort),
  WEB_ORIGINS: `${localUrl},${phoneUrl}`,
  PUBLIC_WEB_URL: phoneUrl,
  COOKIE_SECURE: "false",
};

console.log("\nKiwiGames mobile preview");
console.log(`Phone: ${phoneUrl}`);
console.log(`Mac:   ${localUrl}`);
console.log("Keep this window open and put the phone on the same Wi-Fi network.\n");

const children = [
  spawn(
    "corepack",
    ["pnpm", "--filter", "@anagrams/server", "dev"],
    { env: sharedEnv, stdio: "inherit" },
  ),
  spawn(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@anagrams/web",
      "dev",
      "--host",
      "0.0.0.0",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    { env: sharedEnv, stdio: "inherit" },
  ),
];

let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250).unref();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(`Unable to start mobile preview: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`A preview process stopped (${signal ?? `code ${code}`}).`);
      stop(code ?? 1);
    }
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
