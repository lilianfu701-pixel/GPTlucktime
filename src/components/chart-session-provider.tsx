"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

import type { NormalizedBirthInput } from "../core/types";

interface ChartSessionContextValue {
  readonly pendingBirthInput: NormalizedBirthInput | null;
  readonly setBirthInput: (input: NormalizedBirthInput) => void;
  readonly clearBirthInput: () => void;
}

const ChartSessionContext = createContext<ChartSessionContextValue | null>(null);

export function ChartSessionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [pendingBirthInput, setPendingBirthInput] =
    useState<NormalizedBirthInput | null>(null);

  return (
    <ChartSessionContext.Provider
      value={{
        pendingBirthInput,
        setBirthInput: setPendingBirthInput,
        clearBirthInput: () => setPendingBirthInput(null),
      }}
    >
      {children}
    </ChartSessionContext.Provider>
  );
}

export function useChartSession(): ChartSessionContextValue {
  const context = useContext(ChartSessionContext);
  if (!context) {
    throw new Error("useChartSession must be used within ChartSessionProvider.");
  }
  return context;
}
