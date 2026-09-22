import type { PublicProfile } from "@humansandmachines/gsv/protocol";
import { useEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { readProfileAvatar } from "../../../services/system/profileService";

export function PublicProfileImage({ profile }: { profile: PublicProfile }) {
  const { client, connected } = useGateway();
  const sha256 = profile.avatar?.sha256;
  const source = `${profile.url}#${sha256}`;
  const [image, setImage] = useState<{ source: string; url?: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!sha256 || !connected) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    setImage(null);
    void readProfileAvatar(client, sha256, abort.signal, profile.url).then((blob) => {
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ source, url: objectUrl });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setImage({ source, error: cause instanceof Error ? cause.message : "Profile image unavailable" });
    });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, connected, sha256, profile.url, source, attempt]);
  if (!sha256) return null;
  const current = image?.source === source ? image : null;
  return <div class="people-profile-image">
    {current?.url ? <img src={current.url} alt={`${profile.displayName}’s profile image`} width={96} height={96} />
      : current?.error ? <p class="people-note" role="status">Image unavailable. <button class="people-action" disabled={!connected} title={current.error} onClick={() => setAttempt(attempt + 1)}>retry image</button></p>
      : <span class="people-note" role="status">{connected ? "Loading profile image…" : "Image available when reconnected"}</span>}
  </div>;
}
