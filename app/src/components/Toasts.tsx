import { useStore } from "../state/store";

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "err" ? "err" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
