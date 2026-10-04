"use client";

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="stack">
      <h1>Something went wrong</h1>
      <p className="msg error" role="alert">{error.message || "We could not complete that action. Your latest typed changes, if still on the previous form, were not discarded by this screen."}</p>
      <button className="btn" type="button" onClick={() => reset()}>Try again</button>
    </div>
  );
}
