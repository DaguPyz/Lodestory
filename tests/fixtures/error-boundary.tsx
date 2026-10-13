import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../../src/plugins/error-ui/ErrorBoundary';

declare global {
  interface Window {
    __uncaughtErrorCalls: string[];
    __bCounterNode?: HTMLElement | null;
  }
}

window.__uncaughtErrorCalls = [];

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button id="b-counter" onClick={() => setCount((value) => value + 1)}>
      B count: {count}
    </button>
  );
}

function AContent({ shouldFail }: { shouldFail: boolean }) {
  if (shouldFail) {
    throw new Error('error-boundary fixture: A failed while rendering');
  }
  return <p id="a-content">A is healthy</p>;
}

function LocalBoundaryCase() {
  const [aShouldFail, setAShouldFail] = useState(false);
  return (
    <main>
      <section id="a-region">
        <ErrorBoundary>
          <button id="trigger-a" onClick={() => setAShouldFail(true)}>
            Trigger A failure
          </button>
          <AContent shouldFail={aShouldFail} />
        </ErrorBoundary>
      </section>
      <section id="b-region">
        <Counter />
      </section>
    </main>
  );
}

function ThrowingWrapper({ fail, onTrigger }: { fail: boolean; onTrigger: () => void }) {
  if (fail) {
    throw new Error('error-boundary fixture: wrapper failed while rendering');
  }
  return (
    <div id="wrapper-content">
      <button id="trigger-wrapper" onClick={onTrigger}>
        Trigger wrapper failure
      </button>
      <p>Wrapper is healthy</p>
    </div>
  );
}

function OuterBoundaryCase() {
  const [wrapperShouldFail, setWrapperShouldFail] = useState(false);
  return (
    <ErrorBoundary>
      <ThrowingWrapper
        fail={wrapperShouldFail}
        onTrigger={() => setWrapperShouldFail(true)}
      />
    </ErrorBoundary>
  );
}

const mode = new URLSearchParams(window.location.search).get('mode');
const root = createRoot(document.getElementById('root')!, {
  onUncaughtError(error) {
    window.__uncaughtErrorCalls.push(String(error));
  },
});

root.render(mode === 'outer' ? <OuterBoundaryCase /> : <LocalBoundaryCase />);
