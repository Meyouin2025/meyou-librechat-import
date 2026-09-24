import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { CSSProperties, ReactNode } from 'react';
import {
  useExpandCollapse,
  useLazyCollapseBody,
  scheduleMessageContentLayoutReconcile,
  EXPAND_TRANSITION,
} from '~/hooks';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import { getActivityLabelText } from '~/utils/activityLabels';
import { EmptyText } from './Parts';
import Container from './Container';
import { cn } from '~/utils';

/** Matches `EXPAND_TRANSITION` so the header, the panel, and the card chrome
 * all resolve on the same curve — three properties animating on two different
 * easings is what makes a fold read as two separate movements. */
const FOLD_EASING = 'duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none';

type ActivityPhasePart = Extract<TMessageContentParts, { type: ContentTypes.ACTIVITY_LABEL }> & {
  activity_label_type?: 'phase';
  activity_start_index?: number;
  activity_end_index?: number;
};

function schedulePostPaint(callback: () => void): () => void {
  let frameId: number | undefined;
  frameId = window.requestAnimationFrame(() => {
    frameId = window.requestAnimationFrame(() => {
      frameId = undefined;
      callback();
    });
  });
  return () => {
    if (frameId != null) {
      window.cancelAnimationFrame(frameId);
      frameId = undefined;
    }
  };
}

export default function ActivityPhaseGroup({
  labelPart,
  children,
  hasContent,
  showCursor = false,
  animateEntrance = false,
  hasPendingApproval = false,
}: {
  labelPart: ActivityPhasePart;
  children: ReactNode;
  hasContent: boolean;
  showCursor?: boolean;
  animateEntrance?: boolean;
  hasPendingApproval?: boolean;
}) {
  const label = getActivityLabelText(labelPart);
  const hasFailure = labelPart.status === 'failed' || labelPart.status === 'partial';
  const canContinueProgrammer = /paused\s*-?\s*needs attention|needs attention/i.test(label);
  const [isContinuing, setIsContinuing] = useState(false);
  const [continueError, setContinueError] = useState('');

  const handleProgrammerContinue = useCallback(async () => {
    if (isContinuing) {
      return;
    }
    setIsContinuing(true);
    setContinueError('');
    try {
      const response = await fetch('/api/meyou/programmer/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'continue' }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || `Continue failed (HTTP ${response.status})`);
      }
    } catch (error) {
      setContinueError(error instanceof Error ? error.message : 'Continue failed');
      setIsContinuing(false);
    }
  }, [isContinuing]);
  const isProgrammerWorking =
    labelPart.status === undefined &&
    /planning|syncing workspace|inspecting files|reading a file|editing a file|running tests|diagnosing|reviewing diff|using tools/i.test(
      label,
    );
  const smoothStreaming = useSmoothStreaming();
  const [shouldAnimateEntrance] = useState(smoothStreaming && animateEntrance && label.length > 0);
  const foldsIn = shouldAnimateEntrance && hasContent;
  const [isExpanded, setIsExpanded] = useState(foldsIn);
  const [isSettled, setIsSettled] = useState(!foldsIn);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const cancelEntranceRef = useRef<(() => void) | null>(null);
  const cancelLayoutReconcileRef = useRef<(() => void) | null>(null);
  const previousIsExpandedRef = useRef(isExpanded);
  const userOverrideRef = useRef(false);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(
    isExpanded,
    hasPendingApproval,
  );

  useEffect(() => {
    if (!foldsIn || userOverrideRef.current) {
      return;
    }
    cancelEntranceRef.current = schedulePostPaint(() => {
      cancelEntranceRef.current = null;
      if (userOverrideRef.current) {
        return;
      }
      setIsSettled(true);
      setIsExpanded(false);
    });
    return () => {
      cancelEntranceRef.current?.();
      cancelEntranceRef.current = null;
    };
  }, [foldsIn]);

  useEffect(() => {
    const wasExpanded = previousIsExpandedRef.current;
    previousIsExpandedRef.current = isExpanded;
    if (wasExpanded && !isExpanded) {
      cancelLayoutReconcileRef.current?.();
      cancelLayoutReconcileRef.current = scheduleMessageContentLayoutReconcile(rootRef.current);
    }
  }, [isExpanded]);

  useEffect(
    () => () => {
      cancelLayoutReconcileRef.current?.();
    },
    [],
  );

  const handleToggle = useCallback(() => {
    userOverrideRef.current = true;
    cancelEntranceRef.current?.();
    cancelEntranceRef.current = null;
    mountBody();
    setIsSettled(true);
    setIsExpanded((expanded) => !expanded);
  }, [mountBody]);

  const headerStyle = useMemo<CSSProperties | undefined>(() => {
    if (!foldsIn) {
      return undefined;
    }
    return {
      display: 'grid',
      gridTemplateRows: isSettled ? '1fr' : '0fr',
      transition: EXPAND_TRANSITION,
      opacity: isSettled ? 1 : 0,
    };
  }, [foldsIn, isSettled]);

  const cursor = showCursor ? (
    <Container>
      <EmptyText />
    </Container>
  ) : null;
  if (!label) {
    return <>{children}</>;
  }
  const group = !hasContent ? (
    <div
      className={cn(
        'my-2 flex min-h-10 w-full items-center rounded-lg border border-border-light bg-surface-secondary/40 px-3 py-2 text-text-secondary',
        shouldAnimateEntrance && `animate-in fade-in-0 motion-reduce:animate-none ${FOLD_EASING}`,
      )}
    >
      {isProgrammerWorking && (
        <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-left text-sm font-medium',
          hasFailure && 'text-text-warning',
        )}
        role="status"
        title={label}
      >
        {label}
      </span>
      {canContinueProgrammer && (
        <Button
          variant="outline"
          type="button"
          disabled={isContinuing}
          onClick={() => void handleProgrammerContinue()}
          className="ml-2 h-8 shrink-0 px-3"
        >
          {isContinuing ? 'Continuing…' : 'Continue'}
        </Button>
      )}
      {continueError && <span className="ml-2 text-xs text-text-warning">{continueError}</span>}
    </div>
  ) : (
    <div
      className={cn(
        'my-2 w-full rounded-lg border transition-colors',
        FOLD_EASING,
        isSettled ? 'border-border-light bg-surface-secondary/40' : 'border-transparent',
      )}
      ref={rootRef}
    >
      <div style={headerStyle}>
        <div className="flex items-center overflow-hidden">
          <Button
            variant="ghost"
            type="button"
            className="flex h-auto min-h-10 min-w-0 flex-1 items-center justify-start gap-2 rounded-lg bg-transparent px-3 py-2 text-left text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary focus-visible:ring-offset-0"
            onClick={handleToggle}
            aria-expanded={isExpanded}
            aria-controls={panelId}
            aria-label={label}
            title={label}
          >
            {isProgrammerWorking && (
              <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-left text-sm font-medium',
                hasFailure && 'text-text-warning',
              )}
              role="status"
            >
              {label}
            </span>
            <ChevronDown
              className={cn(
                'size-4 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
                isExpanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </Button>
          {canContinueProgrammer && (
            <Button
              variant="outline"
              type="button"
              disabled={isContinuing}
              onClick={() => void handleProgrammerContinue()}
              className="mr-2 h-8 shrink-0 px-3"
            >
              {isContinuing ? 'Continuing…' : 'Continue'}
            </Button>
          )}
          {continueError && <span className="mr-2 text-xs text-text-warning">{continueError}</span>}
        </div>
      </div>
      <div
        id={panelId}
        style={expandStyle}
        onTransitionEnd={handleTransitionEnd}
        aria-hidden={!isExpanded}
        data-testid="activity-phase-panel"
      >
        {shouldRenderBody && (
          <div className="overflow-hidden" ref={expandRef}>
            <div
              className={cn(
                'border-t transition-[border-color,padding]',
                FOLD_EASING,
                isSettled ? 'border-border-light px-3 py-2' : 'border-transparent px-0 py-0',
              )}
            >
              {children}
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <>
      {group}
      {cursor}
    </>
  );
}
