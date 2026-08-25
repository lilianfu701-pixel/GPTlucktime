export function FreeTestBanner({ children }: { children: React.ReactNode }) {
  return (
    <aside
      className="w-full max-w-full break-words border-b border-amber-300 bg-amber-100 px-3 py-2 text-center text-sm leading-5 text-amber-950 sm:px-4"
      role="status"
    >
      {children}
    </aside>
  );
}
