import type { CSSProperties } from "react";

export function ProfilePhoto({ name, position, className = "" }: { name: string; position: string; className?: string }) {
  const style: CSSProperties = {
    backgroundImage: "url('/demo/profile-sprite-8.webp')",
    backgroundPosition: position,
    backgroundSize: "400% 200%",
  };
  return <div aria-label={name} className={`datecn-photo ${className}`} role="img"><span aria-hidden="true" className="datecn-photo-sprite" style={style} /></div>;
}
