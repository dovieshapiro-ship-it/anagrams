export type InviteCopyResult = "copied" | "failed";

export async function copyInvite(url: string): Promise<InviteCopyResult> {
  const capabilities = navigator as unknown as {
    readonly clipboard?: Pick<Clipboard, "writeText">;
  };
  if (capabilities.clipboard?.writeText) {
    try {
      await capabilities.clipboard.writeText(url);
      return "copied";
    } catch {
      // Clipboard access is commonly denied on non-secure LAN origins.
    }
  }

  const field = document.createElement("textarea");
  field.value = url;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();

  try {
    // Required for HTTP LAN play, where the modern Clipboard API is withheld.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (document.execCommand("copy")) return "copied";
  } catch {
    // Older browsers can expose execCommand but still reject the copy.
  } finally {
    field.remove();
  }

  return "failed";
}
