import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    .filter(el => !el.hasAttribute("disabled") && el.offsetParent !== null);
}

/**
 * The bottom sheet — or, past 760px, the floating card — that every panel in the app lives in.
 *
 * It exists because the markup that used to be inlined at each call site was a plain <section>:
 * no dialog role, so nothing announced that a layer had opened; no focus trap, so Tab walked
 * straight out behind the scrim into the conversation list; and no Escape, which the lightbox
 * has always honoured and the sheets never did.
 *
 * The grab handle is a real button rather than decoration. It is drawn like something you could
 * drag, there is no drag gesture behind it, and the cheapest way to stop that being a lie is to
 * make tapping it do the thing it looks like it would do.
 */
export function Sheet({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const focusable = focusableWithin(sheet.current);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !sheet.current?.contains(active);
      if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  // The Tab handler above stops focus walking out; `inert` stops everything else — a screen
  // reader's own cursor, a click that lands past the sheet's edge, the FAB. The sheet is a
  // sibling of these rather than a child, so it stays live while they do not.
  useEffect(() => {
    const behind = [...document.querySelectorAll(".sidebar, .chat")];
    behind.forEach(el => el.setAttribute("inert", ""));
    return () => behind.forEach(el => el.removeAttribute("inert"));
  }, []);

  // Focus goes in on open and back where it came from on close, so dismissing a sheet with the
  // keyboard does not drop you at the top of the document.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = sheet.current?.querySelector<HTMLElement>("input, textarea") ?? focusableWithin(sheet.current)[0];
    target?.focus();
    return () => previous?.focus?.();
  }, []);

  return <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <section className="sheet" role="dialog" aria-modal="true" aria-label={label} ref={sheet}>
      <button className="grab" onClick={onClose} aria-label="Close"/>
      {children}
    </section>
  </div>;
}
