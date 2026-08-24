import type { SVGProps } from "react";

const paths = {
  discover: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3-12-2 4-4 2 2-4 4-2Z",
  matches: "M12 20S4 15 4 9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 6-6 11-6 11Z",
  messages: "M4 5h16v11H8l-4 3V5Z",
  membership: "m12 3 3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L3 10l6-1 3-6Z",
  me: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
} as const;

export type DateCNIconName = keyof typeof paths;
export function DateCNIcon({ name, ...props }: { name: DateCNIconName } & SVGProps<SVGSVGElement>) {
  return <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 24 24" width="22" {...props}><path d={paths[name]} fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /></svg>;
}
