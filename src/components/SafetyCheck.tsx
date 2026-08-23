/**
 * The two rows of pictures two people compare, in person, once.
 *
 * Each row is a fingerprint of one device's public key, and both devices work theirs out from the
 * keys they actually received. That is the entire point: a code that travelled here from the
 * other phone would match no matter who had rewritten it on the way, which is what the old one
 * did. These only match when both ends are holding the keys they think they are.
 *
 * It is a screen rather than a toast because somebody looking at it has to be told what the
 * pictures are for and what to do when they disagree.
 */
export function SafetyCheck({ code, title }: { code: string; title: string }) {
  return <div className="safety">
    <b>🎉</b>
    <strong>{title}</strong>
    <div className="safety-rows">
      {code.split("\n").map(row => <span key={row}>{row}</span>)}
    </div>
    <small>
      Hold the two phones together and check these pictures — same pictures, same order, both rows.
      If they don’t match, stop and set it up again.
    </small>
  </div>;
}
