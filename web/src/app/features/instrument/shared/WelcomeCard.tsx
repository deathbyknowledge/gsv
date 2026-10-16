import { useEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import "./welcome-card.css";

const WELCOME_SEEN = "ui/welcome_card_seen";

/** The person's config follows them between the web app and Desktop. */
export function WelcomeCard() {
  const { client, connected } = useGateway();
  const [ownerUid, setOwnerUid] = useState<number | null>(null);
  const checked = useRef(false);

  useEffect(() => {
    if (!connected || checked.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const { accounts } = await client.account.list({});
        const uid = accounts.find((account) => account.relation === "self")?.uid;
        if (uid === undefined || uid < 1000) {
          if (!cancelled) checked.current = true;
          return;
        }
        const key = `users/${uid}/${WELCOME_SEEN}`;
        const { entries } = await client.sys.config.get({ key });
        if (cancelled) return;
        checked.current = true;
        if (!entries.some((entry) => entry.key === key && entry.value === "1")) setOwnerUid(uid);
      } catch (error) {
        if (!cancelled) console.error("Could not load the welcome card state", error);
      }
    })();
    return () => { cancelled = true; };
  }, [client, connected]);

  const dismiss = () => {
    if (ownerUid === null) return;
    const key = `users/${ownerUid}/${WELCOME_SEEN}`;
    setOwnerUid(null);
    void client.sys.config.set({ key, value: "1" }).catch((cause: unknown) => {
      console.error("Could not save the welcome card state", cause);
    });
  };

  if (ownerUid === null) return null;
  return <aside class="welcome-card" role="dialog" aria-labelledby="welcome-card-title">
    <button type="button" class="welcome-card-close" aria-label="Dismiss welcome" onClick={dismiss}>×</button>
    <h2 id="welcome-card-title">Welcome to your Ship!</h2>
    <p>I'm Kawah, one of the founders of Ship. Steve, Jessica and I have been building this for the past months, and we're really happy you're here!</p>
    <p>Ship is still early, so you might run into some rough edges. If something breaks, feels confusing, or makes you think "I wish it could…", we'd love to hear from you.</p>
    <p>You can use the Feedback button in the top anytime, or talk to us directly on <a href="https://discord.gg/hy9ExJJFvn" target="_blank" rel="noopener noreferrer">Discord</a> (and see Steve's dog).</p>
    <p>Thanks for being one of the first. It means a lot to us!</p>
    <p>Kawah :)</p>
    <button type="button" class="welcome-card-try" onClick={dismiss}>Try it out!</button>
  </aside>;
}
