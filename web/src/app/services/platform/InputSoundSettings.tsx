import { setSoundPreferences, unlockInputAudio, playInputCue } from "./inputSounds";
import { useSoundPreferences } from "./useInputSounds";

export function InputSoundSettings() {
  const preferences = useSoundPreferences();
  return <fieldset class="native-sound-settings">
    <legend>Sounds</legend>
    {(["voice", "keys"] as const).map((kind) => <label key={kind}>
      <input type="checkbox" checked={preferences[kind]} onChange={(event) => {
        const enabled = event.currentTarget.checked;
        setSoundPreferences({ ...preferences, [kind]: enabled });
        if (enabled) { unlockInputAudio(); playInputCue(kind === "keys" ? "character" : "listening", kind); }
      }} />{kind === "keys" ? "keypresses" : "voice"}
    </label>)}
  </fieldset>;
}
