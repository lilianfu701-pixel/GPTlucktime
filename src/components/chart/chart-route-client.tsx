"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { generateChart, type GenerateChartResult } from "../../app/actions/generate-chart";
import type { NormalizedBirthInput } from "../../core/types";
import type { ChartViewModel } from "../../lib/chart-view-model";
import { useChartSession } from "../chart-session-provider";
import { ChartWorkbench } from "./chart-workbench";
import styles from "./chart-workbench.module.css";

type RouteState = "idle" | "loading" | "error";

interface RouteError {
  readonly message: string;
  readonly retryable: boolean;
}

interface RequestRecord {
  readonly input: NormalizedBirthInput;
  readonly generation: number;
  readonly promise: Promise<GenerateChartResult>;
}

export function ChartRouteClient() {
  const { pendingBirthInput, clearBirthInput } = useChartSession();
  const [viewModel, setViewModel] = useState<ChartViewModel | null>(null);
  const [routeState, setRouteState] = useState<RouteState>("idle");
  const [routeError, setRouteError] = useState<RouteError | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestRef = useRef<RequestRecord | null>(null);

  useEffect(() => {
    if (viewModel || !pendingBirthInput) return;

    setRouteState("loading");
    setRouteError(null);
    const current = requestRef.current;
    if (
      !current ||
      current.input !== pendingBirthInput ||
      current.generation !== retryGeneration
    ) {
      requestRef.current = {
        input: pendingBirthInput,
        generation: retryGeneration,
        promise: generateChart(pendingBirthInput),
      };
    }

    const request = requestRef.current;
    if (!request) return;
    const releaseRequest = () => {
      if (requestRef.current === request) requestRef.current = null;
    };
    let active = true;
    request.promise.then(
      (result) => {
        if (!active) return;
        releaseRequest();
        if (result.ok) {
          setViewModel(result.viewModel);
          setRouteState("idle");
          // Release the complete request record before clearing its source context.
          clearBirthInput();
          return;
        }
        setRouteError({
          message: result.error.message,
          retryable: result.error.retryable,
        });
        setRouteState("error");
      },
      () => {
        if (!active) return;
        releaseRequest();
        setRouteError({
          message: "命盘生成请求失败，请重试。",
          retryable: true,
        });
        setRouteState("error");
      },
    );

    return () => {
      active = false;
    };
  }, [clearBirthInput, pendingBirthInput, retryGeneration, viewModel]);

  const restartEntry = () => {
    requestRef.current = null;
    setViewModel(null);
    setRouteState("idle");
    setRouteError(null);
    setRetryGeneration(0);
    clearBirthInput();
  };

  if (viewModel) {
    return (
      <main className={styles.page}>
        <ChartWorkbench viewModel={viewModel} onRestart={restartEntry} />
      </main>
    );
  }

  if (!pendingBirthInput) {
    return (
      <main className={styles.page}>
        <section className={styles.emptyState}>
          <p className={styles.eyebrow}>会话资料已清空</p>
          <h1>本次会话没有出生资料</h1>
          <p>请先完成出生时间与地点校验，再进入固定命盘。</p>
          <Link href="/">返回出生资料录入</Link>
        </section>
      </main>
    );
  }

  if (routeState === "error") {
    return (
      <main className={styles.page}>
        <section className={styles.errorState} aria-labelledby="generation-error-heading">
          <p className={styles.eyebrow}>生成未完成</p>
          <h1 id="generation-error-heading">命盘生成暂时中断</h1>
          <p role="alert">{routeError?.message}</p>
          {routeError?.retryable ? (
            <button
              type="button"
              onClick={() => setRetryGeneration((value) => value + 1)}
              autoFocus
            >
              重新生成
            </button>
          ) : null}
          <Link href="/">返回修改出生资料</Link>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section
        className={styles.loadingState}
        role="status"
        aria-label="命盘生成状态"
        aria-live="polite"
      >
        <p className={styles.eyebrow}>校时 · 节气 · 四柱 · 指标</p>
        <h1>正在校时并生成静态命盘</h1>
        <div className={styles.loadingGrid} aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
        </div>
      </section>
    </main>
  );
}
