/** The green box with a gold ribbon and bow. Purely decorative. */
export function GiftBox({ variant = "box", className = "" }: { variant?: "box" | "card"; className?: string }) {
  return (
    <div className={`wrap wrap--${variant} ${className}`} aria-hidden="true">
      <span className="wrap__ribbon wrap__ribbon--v" />
      <span className="wrap__ribbon wrap__ribbon--h" />
      {variant === "box" && <span className="wrap__lid" />}
      <span className="wrap__bow">
        <span className="wrap__loop wrap__loop--l" />
        <span className="wrap__loop wrap__loop--r" />
        <span className="wrap__knot" />
      </span>
    </div>
  );
}
