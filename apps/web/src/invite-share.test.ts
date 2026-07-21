import { afterEach, describe, expect, it, vi } from "vitest";
import { copyInvite } from "./invite-share";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "clipboard",
);
afterEach(() => {
  vi.restoreAllMocks();
  if (clipboardDescriptor)
    Object.defineProperty(Navigator.prototype, "clipboard", clipboardDescriptor);
  else delete (Navigator.prototype as { clipboard?: Clipboard }).clipboard;
});

describe("copyInvite", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => ({ writeText }),
    });

    await expect(copyInvite("http://192.168.1.5/game")).resolves.toBe(
      "copied",
    );
    expect(writeText).toHaveBeenCalledWith("http://192.168.1.5/game");
  });

  it("falls back to legacy copy on non-secure origins", async () => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => undefined,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await expect(copyInvite("http://192.168.1.5/game")).resolves.toBe(
      "copied",
    );
    expect(execCommand).toHaveBeenCalledOnce();
    expect(document.querySelector("textarea")).toBeNull();
  });
});
