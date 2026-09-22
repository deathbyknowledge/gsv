import { useEffect, useRef, useState } from "preact/hooks";
import type { ProfileAvatar } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { readProfileAvatar, uploadProfileAvatar } from "../../../services/system/profileService";

type Crop = { zoom: number; x: number; y: number };
const INITIAL_CROP: Crop = { zoom: 1, x: .5, y: .5 };

function drawCrop(canvas: HTMLCanvasElement, source: ImageBitmap, crop: Crop): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not open the image editor");
  const size = Math.min(source.width, source.height) / crop.zoom;
  context.clearRect(0, 0, 256, 256);
  context.drawImage(source, (source.width - size) * crop.x, (source.height - size) * crop.y, size, size, 0, 0, 256, 256);
}

export function ProfileAvatarPreview({ avatar }: { avatar?: ProfileAvatar }) {
  const { client, connected } = useGateway();
  const [image, setImage] = useState<{ sha256: string; url: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setImage(null);
    if (!avatar || !connected) return;
    const abort = new AbortController();
    let url: string | undefined;
    void readProfileAvatar(client, avatar.sha256, abort.signal).then((blob) => {
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setImage({ sha256: avatar.sha256, url });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Image preview unavailable");
    });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [client, connected, avatar?.sha256]);
  if (!avatar) return null;
  return <>{image?.sha256 === avatar.sha256 ? <img class="settings-profile-avatar" src={image.url} width={112} height={112} alt="Your profile image" />
    : <p class="settings-muted" role="status">{error || (connected ? "Loading image…" : "Connect to preview your image")}</p>}</>;
}

export function ProfileAvatarEditor({ avatar, disabled, onChange, onEditing }: {
  avatar?: ProfileAvatar; disabled: boolean;
  onChange: (avatar: ProfileAvatar | undefined) => void;
  onEditing: (editing: boolean) => void;
}) {
  const { client } = useGateway();
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [crop, setCrop] = useState(INITIAL_CROP);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const selection = useRef(0);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { selection.current++; operation.current?.abort(); }, []);
  useEffect(() => () => { source?.close(); }, [source]);
  useEffect(() => { onEditing(!!source || pending); return () => onEditing(false); }, [source, pending, onEditing]);
  useEffect(() => { if (canvas.current && source) drawCrop(canvas.current, source, crop); }, [source, crop]);

  const choose = async (file: File) => {
    const version = ++selection.current;
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setError("Choose a PNG, JPEG or WebP image up to 8 MiB."); return;
    }
    setPending(true);
    try {
      const bitmap = await createImageBitmap(file);
      if (version !== selection.current) { bitmap.close(); return; }
      if (bitmap.width > 8192 || bitmap.height > 8192) { bitmap.close(); throw new Error("Choose an image at most 8,192 pixels on each side."); }
      setCrop(INITIAL_CROP); setSource(bitmap);
    } catch (cause) {
      if (version === selection.current) setError(cause instanceof Error ? cause.message : "Unable to open this image");
    } finally { if (version === selection.current) setPending(false); }
  };
  const save = async () => {
    if (!source || !canvas.current || disabled || pending) return;
    const abort = new AbortController();
    operation.current = abort;
    setPending(true); setError("");
    try {
      drawCrop(canvas.current, source, crop);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.current!.toBlob((value) => value ? resolve(value) : reject(new Error("Unable to export this crop")), "image/png"));
      const uploaded = await uploadProfileAvatar(client, blob, abort.signal);
      if (abort.signal.aborted) return;
      onChange(uploaded); setSource(null);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to upload this image");
    } finally {
      if (!abort.signal.aborted) setPending(false);
      if (operation.current === abort) operation.current = null;
    }
  };

  return <fieldset class="settings-avatar-editor" disabled={disabled || pending}>
    <legend>Profile image <span class="settings-muted">· optional</span></legend>
    <p class="settings-muted">Choose an image, then adjust the crop. Only the finished image is uploaded; it stays private until you publish.</p>
    <label class="settings-avatar-file">Choose an image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
      if (file) void choose(file);
    }} /></label>
    {source && <div class="settings-avatar-crop">
      <canvas ref={canvas} width={256} height={256} role="img" aria-label="Preview of your profile image crop" />
      <div class="settings-avatar-sliders">
        <label>Zoom<input type="range" min={1} max={3} step={.01} value={crop.zoom} onInput={(event) => setCrop({ ...crop, zoom: event.currentTarget.valueAsNumber })} /></label>
        <label>Horizontal position<input type="range" min={0} max={1} step={.01} value={crop.x} onInput={(event) => setCrop({ ...crop, x: event.currentTarget.valueAsNumber })} /></label>
        <label>Vertical position<input type="range" min={0} max={1} step={.01} value={crop.y} onInput={(event) => setCrop({ ...crop, y: event.currentTarget.valueAsNumber })} /></label>
        <div class="settings-actions"><button type="button" class="ibtn" onClick={() => { void save(); }}>use this image</button><button type="button" class="settings-text-action" onClick={() => { setSource(null); setError(""); }}>cancel</button></div>
      </div>
    </div>}
    {pending && <p class="settings-muted" role="status">Preparing your image…</p>}
    {error && <p class="settings-error" role="alert">{error}</p>}
    {avatar && !source && <button type="button" class="settings-text-action" onClick={() => onChange(undefined)}>remove image from draft</button>}
  </fieldset>;
}
