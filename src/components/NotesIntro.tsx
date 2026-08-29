import { NOTES_EMOJI } from "../lib/notes";

/**
 * What the room you keep for yourself says before you have put anything in it.
 *
 * An empty chat is a prompt whether it means to be or not, and "Say hi!" is the wrong prompt
 * here — there is nobody to say it to. So the card answers the question somebody actually has
 * the first time they open it: what is this for, and who can see it. The three buttons are the
 * three things it turns out to be for, in the order people reach for them.
 *
 * It does not guess whether this person has a second screen. Nothing on the device honestly
 * knows — a laptop and a phone are the same member, which is exactly what makes this room worth
 * having — so the line points at where to find out rather than asserting either way.
 */
export function NotesIntro({ onNote, onList, onPhoto, onDevices }: {
  onNote(): void; onList(): void; onPhoto(): void; onDevices(): void;
}) {
  return <div className="notes-intro">
    <span className="notes-intro-face" aria-hidden>{NOTES_EMOJI}</span>
    <strong>This one is just yours</strong>
    <p>
      Park a link to read later, jot down the thing you keep forgetting, keep a photo somewhere
      you can find it again. Nothing here expires, and nobody else can see it — not even the relay.
    </p>
    <div className="notes-chips">
      <button onClick={onNote}>✏️ Jot a note</button>
      <button onClick={onList}>✅ Start a list</button>
      <button onClick={onPhoto}>🖼️ Keep a photo</button>
    </div>
    <button className="notes-hint" onClick={onDevices}>
      💻 It’s on <b>every screen</b> you use Kin on — so something you drop in here on the laptop is
      on your phone by the time you pick it up.
    </button>
  </div>;
}
