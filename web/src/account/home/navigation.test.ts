import { describe, expect, it, vi } from "vitest";
import {
  saveInstallationExport,
  submitInstallationHandoff,
} from "./navigation";

describe("managed account navigation", () => {
  it("submits a one-use bearer as a POST body and removes it from the DOM", () => {
    const form = {
      method: "",
      action: "",
      hidden: false,
      append: vi.fn(),
      submit: vi.fn(),
      remove: vi.fn(),
    };
    const token = { type: "", name: "", value: "" };
    const documentRef = {
      createElement: vi.fn()
        .mockReturnValueOnce(form)
        .mockReturnValueOnce(token),
      body: { append: vi.fn() },
    } as unknown as Document;

    submitInstallationHandoff({
      action: "https://hank.gsv.space/auth/handoff",
      token: "handoff_secret",
      expiresAt: 1_900_000_000_000,
    }, documentRef);

    expect(form).toMatchObject({
      method: "POST",
      action: "https://hank.gsv.space/auth/handoff",
      hidden: true,
    });
    expect(token).toEqual({
      type: "hidden",
      name: "token",
      value: "handoff_secret",
    });
    expect(form.append).toHaveBeenCalledWith(token);
    expect(documentRef.body.append).toHaveBeenCalledWith(form);
    expect(form.submit).toHaveBeenCalledOnce();
    expect(form.remove).toHaveBeenCalledOnce();
  });

  it("cancels an unclaimed export stream when file selection is cancelled", async () => {
    const response = new Response("archive");
    const cancel = vi.spyOn(response.body!, "cancel");
    const windowRef = {
      showSaveFilePicker: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    } as unknown as Window;

    await expect(saveInstallationExport({
      response,
      filename: "gsv-hank.tar",
    }, windowRef)).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
