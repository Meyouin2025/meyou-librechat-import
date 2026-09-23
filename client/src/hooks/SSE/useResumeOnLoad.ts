import { useEffect, useRef } from 'react';
import { useSetRecoilState, useRecoilValue, useRecoilCallback } from 'recoil';
import { Constants, tMessageSchema, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TMessage, TConversation, TSubmission, Agents } from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '~/data-provider/SSE/protocol';
import type { StreamStatusResponse } from '~/data-provider';
import {
  dedupeSteersById,
  appendAppliedSteerIds,
  collectAppliedSteerIds,
  applyPendingAction,
  carriedSteerContext,
  getBranchSiblingIndexesForTarget,
} from '~/utils';
import {
  getGenerationProtocolVersion,
  supportsGenerationProtocolV2,
} from '~/data-provider/SSE/protocol';
import useSteerConvert from '~/hooks/Chat/useSteerConvert';
import { useStreamStatus } from '~/data-provider';
import store from '~/store';

function hasSubmissionUserMessage(
  submission: TSubmission | null,
  messages: TMessage[] | undefined,
  conversationId: string | undefined,
): boolean {
  const userMessageId = submission?.userMessage?.messageId;
  if (!userMessageId || !conversationId || !messages?.length) {
    return false;
  }

  return messages.some(
    (message) =>
      message.isCreatedByUser === true &&
      message.messageId === userMessageId &&
      message.conversationId === conversationId,
  );
}

function resumeStateMatchesSubmission(
  streamStatus: StreamStatusResponse | undefined,
  submission: TSubmission | null,
): boolean {
  const resumeState = streamStatus?.resumeState;
  if (!resumeState || !submission) {
    return false;
  }

  const userMessageId = submission.userMessage?.messageId;
  if (userMessageId && resumeState.userMessage?.messageId === userMessageId) {
    return true;
  }

  const responseMessageId = submission.initialResponse?.messageId;
  return !!responseMessageId && resumeState.responseMessageId === responseMessageId;
}

function activeStreamStatusMatchesSubmission(
  streamStatus: StreamStatusResponse | undefined,
  submission: TSubmission | null,
  conversationId: string,
): boolean {
  if (!streamStatus?.active || !streamStatus.streamId || !submission) {
    return false;
  }

  const resumableSubmission = submission as TSubmission & {
    resumeStreamId?: string;
    resumeGenerationCreatedAt?: number;
  };
  const submissionStreamId =
    resumableSubmission.resumeStreamId ?? submission.conversation?.conversationId ?? conversationId;
  if (submissionStreamId !== streamStatus.streamId) {
    return false;
  }

  return (
    streamStatus.createdAt == null ||
    resumableSubmission.resumeGenerationCreatedAt == null ||
    streamStatus.createdAt === resumableSubmission.resumeGenerationCreatedAt
  );
}

function getResumeBranchTargetMessageId(
  resumeState: Agents.ResumeState,
  messages: TMessage[],
): string | null | undefined {
  const responseMessageId = resumeState.responseMessageId;
  if (!responseMessageId) {
    return resumeState.userMessage?.parentMessageId;
  }

  const unpaddedResponseMessageId = responseMessageId.replace(/_+$/, '');
  let hasResponseMessage = false;
  let hasUnpaddedResponseMessage = false;

  for (const message of messages) {
    if (message.messageId === responseMessageId) {
      hasResponseMessage = true;
      break;
    }

    if (message.messageId === unpaddedResponseMessageId) {
      hasUnpaddedResponseMessage = true;
    }
  }

  if (hasResponseMessage) {
    return responseMessageId;
  }

  if (hasUnpaddedResponseMessage) {
    return unpaddedResponseMessageId;
  }

  return resumeState.userMessage?.parentMessageId;
}

function preferDefinedString(value?: string | null, fallback?: string): string | undefined {
  return value != null && value !== '' ? value : fallback;
}

/**
 * Build a submission object from resume state for reconnected streams.
 * This provides the minimum data needed for useResumableSSE to subscribe.
 */
function buildSubmissionFromResumeState(
  resumeState: Agents.ResumeState,
  streamId: string,
  messages: TMessage[],
  conversationId: string,
  generationCreatedAt?: number,
  generationProtocolVersion: GenerationProtocolVersion = 1,
): TSubmission {
  const userMessageData = resumeState.userMessage;
  const responseMessageId =
    resumeState.responseMessageId ?? `${userMessageData?.messageId ?? 'resume'}_`;

  const existingUserMessage = messages.find(
    (m) => m.isCreatedByUser && m.messageId === userMessageData?.messageId,
  );

  const unpaddedResponseMessageId = responseMessageId.replace(/_+$/, '');
  const existingResponseMessage =
    messages.find((m) => !m.isCreatedByUser && m.messageId === responseMessageId) ??
    messages.find((m) => !m.isCreatedByUser && m.messageId === unpaddedResponseMessageId) ??
    messages.find((m) => !m.isCreatedByUser && m.parentMessageId === userMessageData?.messageId);

  const userMessage: TMessage =
    existingUserMessage ??
    (userMessageData
      ? (tMessageSchema.parse({
          messageId: userMessageData.messageId,
          parentMessageId: userMessageData.parentMessageId ?? Constants.NO_PARENT,
          conversationId: userMessageData.conversationId ?? conversationId,
          text: userMessageData.text ?? '',
          isCreatedByUser: true,
          role: 'user',
        }) as TMessage)
      : (messages[messages.length - 2] ??
        ({
          messageId: 'resume_user_msg',
          conversationId,
          text: '',
          isCreatedByUser: true,
        } as TMessage)));

  let initialResponse: TMessage = {
    messageId: existingResponseMessage?.messageId ?? responseMessageId,
    parentMessageId: existingResponseMessage?.parentMessageId ?? userMessage.messageId,
    conversationId,
    text: '',
    content: (resumeState.aggregatedContent as TMessage['content']) ?? [],
    isCreatedByUser: false,
    role: 'assistant',
    sender: existingResponseMessage?.sender ?? resumeState.sender,
    model: preferDefinedString(existingResponseMessage?.model, resumeState.model),
    iconURL: preferDefinedString(existingResponseMessage?.iconURL, resumeState.iconURL),
  } as TMessage;

  if (resumeState.pendingAction) {
    initialResponse = applyPendingAction(initialResponse, resumeState.pendingAction);
  }

  const conversation: TConversation = {
    conversationId,
    title: 'Resumed Chat',
    endpoint: null,
  } as TConversation;

  const pausedResponseIdUnpadded = initialResponse.messageId.replace(/_+$/, '');
  const dedupedMessages = messages.filter(
    (m) =>
      m.messageId !== userMessage.messageId &&
      m.messageId !== initialResponse.messageId &&
      m.messageId !== pausedResponseIdUnpadded,
  );

  return {
    messages: dedupedMessages,
    userMessage,
    initialResponse,
    conversation,
    isRegenerate: false,
    isTemporary: false,
    endpointOption: {},
    resumeStreamId: streamId,
    ...(generationCreatedAt != null && { resumeGenerationCreatedAt: generationCreatedAt }),
    resumeGenerationProtocolVersion: generationProtocolVersion,
  } as TSubmission & {
    resumeStreamId: string;
    resumeGenerationCreatedAt?: number;
    resumeGenerationProtocolVersion: GenerationProtocolVersion;
  };
}

export default function useResumeOnLoad(
  conversationId: string | undefined,
  getMessages: () => TMessage[] | undefined,
  runIndex = 0,
  messagesLoaded = true,
) {
  const setSubmission = useSetRecoilState(store.submissionByIndex(runIndex));
  const currentSubmission = useRecoilValue(store.submissionByIndex(runIndex));
  const currentConversation = useRecoilValue(store.conversationByIndex(runIndex));
  const endpoint = currentConversation?.endpoint;
  const endpointType = currentConversation?.endpointType;
  const actualEndpoint = endpointType ?? endpoint;
  const resumableEnabled = !isAssistantsEndpoint(actualEndpoint);
  const processedConvoRef = useRef<string | null>(null);
  const inactiveConfirmationRef = useRef<{ conversationId: string; count: number } | null>(null);
  const consumedHandoffGenerationRef = useRef<string | null>(null);
  const restoreResumeBranch = useRecoilCallback(
    ({ set }) =>
      (resumeState: Agents.ResumeState, messages: TMessage[], activeConversationId: string) => {
        const targetMessageId = getResumeBranchTargetMessageId(resumeState, messages);
        const branchIndexes = getBranchSiblingIndexesForTarget(
          messages,
          targetMessageId,
          activeConversationId,
        );

        for (const { parentMessageId, siblingIdx } of branchIndexes) {
          set(store.messagesSiblingIdxFamily(parentMessageId), siblingIdx);
        }
      },
    [],
  );

  const convertSteersToQueued = useSteerConvert();

  const restoreSteerChips = useRecoilCallback(
    ({ set }) =>
      (
        activeConversationId: string,
        pendingSteers: Agents.ResumeState['pendingSteers'],
        generationCreatedAt?: number,
        generationProtocolVersion: GenerationProtocolVersion = 1,
      ) => {
        const acceptedClientIds = (pendingSteers ?? []).flatMap((steer) =>
          steer.clientSteerId ? [steer.clientSteerId] : [],
        );
        if (acceptedClientIds.length > 0) {
          set(store.acceptedSteerClientIdsByConvoId(activeConversationId), (prev) =>
            appendAppliedSteerIds(prev, acceptedClientIds),
          );
        }
        set(store.pendingSteersByConvoId(activeConversationId), (prev) => {
          const chipById = new Map(prev.map((chip) => [chip.steerId, chip]));
          const claimedIds = new Set(
            (pendingSteers ?? []).flatMap((steer) =>
              steer.clientSteerId ? [steer.steerId, steer.clientSteerId] : [steer.steerId],
            ),
          );
          return [
            ...(pendingSteers ?? []).map((steer) => {
              const localChip =
                chipById.get(steer.steerId) ??
                (steer.clientSteerId ? chipById.get(steer.clientSteerId) : undefined);
              const keepLocalPreempt =
                (localChip?.preemptRevision ?? 0) > (steer.preemptRevision ?? 0);
              const chipGenerationCreatedAt = generationCreatedAt ?? localChip?.generationCreatedAt;
              return {
                steerId: steer.steerId,
                ...(steer.clientSteerId && { clientSteerId: steer.clientSteerId }),
                text: steer.text,
                status: 'pending' as const,
                createdAt: steer.createdAt ?? Date.now(),
                ...(steer.files && steer.files.length > 0 && { files: steer.files }),
                ...((keepLocalPreempt ? localChip?.preempt : steer.preempt) === true && {
                  preempt: true,
                }),
                ...((keepLocalPreempt ? localChip?.preemptRevision : steer.preemptRevision) !=
                  null && {
                  preemptRevision: keepLocalPreempt
                    ? localChip?.preemptRevision
                    : steer.preemptRevision,
                }),
                ...(localChip?.queuedOrigin && { queuedOrigin: localChip.queuedOrigin }),
                ...(chipGenerationCreatedAt != null && {
                  generationCreatedAt: chipGenerationCreatedAt,
                }),
                generationProtocolVersion,
                ...carriedSteerContext(localChip),
              };
            }),
            ...prev.filter((steer) => steer.status === 'failed' && !claimedIds.has(steer.steerId)),
          ];
        });
      },
    [],
  );

  const settleAppliedSteerParts = useRecoilCallback(
    ({ set }) =>
      (activeConversationId: string, values: unknown[] | undefined) => {
        const ids = collectAppliedSteerIds(values);
        if (ids.length === 0) {
          return;
        }
        const settled = new Set(ids);
        set(store.appliedSteerIdsByConvoId(activeConversationId), (prev) =>
          appendAppliedSteerIds(prev, ids),
        );
        set(store.pendingSteersByConvoId(activeConversationId), (prev) =>
          prev.filter((steer) => !settled.has(steer.steerId)),
        );
      },
    [],
  );
  const setActiveGenerationCreatedAt = useRecoilCallback(
    ({ set }) =>
      (
        activeConversationId: string,
        createdAt: number,
        generationProtocolVersion: GenerationProtocolVersion,
      ) => {
        set(store.activeGenerationCreatedAtByConvoId(activeConversationId), createdAt);
        set(
          store.activeGenerationProtocolVersionByConvoId(activeConversationId),
          generationProtocolVersion,
        );
      },
    [],
  );
  const clearLocalActiveSubmission = useRecoilCallback(
    ({ reset, set, snapshot }) =>
      (activeConversationId: string, expectedSubmission: TSubmission | null) => {
        if (!expectedSubmission) {
          return;
        }
        const current = snapshot.getLoadable(store.submissionByIndex(runIndex)).getValue();
        if (current !== expectedSubmission) {
          return;
        }
        set(store.submissionByIndex(runIndex), null);
        reset(store.activeGenerationCreatedAtByConvoId(activeConversationId));
        set(store.activeGenerationProtocolVersionByConvoId(activeConversationId), 1);
      },
    [runIndex],
  );

  const submissionConvoId = currentSubmission?.conversation?.conversationId;
  const loadedMessages = messagesLoaded ? getMessages() : undefined;
  const hasExplicitSubmissionMatch = !!conversationId && submissionConvoId === conversationId;
  const hasHydratedMessageMatch =
    submissionConvoId == null &&
    hasSubmissionUserMessage(currentSubmission, loadedMessages, conversationId);
  const hasActiveSubmissionForThisConvo =
    !!currentSubmission && (hasExplicitSubmissionMatch || hasHydratedMessageMatch);
  const hasStaleSubmissionForDifferentConvo =
    !!currentSubmission && submissionConvoId != null && submissionConvoId !== conversationId;

  const shouldCheck =
    resumableEnabled &&
    messagesLoaded &&
    !!conversationId &&
    conversationId !== Constants.NEW_CONVO &&
    (processedConvoRef.current !== conversationId || hasActiveSubmissionForThisConvo);

  const {
    data: streamStatus,
    isSuccess,
    isFetching,
    isError,
  } = useStreamStatus(conversationId, shouldCheck);

  useEffect(() => {
    console.log('[ResumeOnLoad] Effect check', {
      resumableEnabled,
      conversationId,
      messagesLoaded,
      hasCurrentSubmission: !!currentSubmission,
      currentSubmissionConvoId: currentSubmission?.conversation?.conversationId,
      isSuccess,
      isFetching,
      streamStatusActive: streamStatus?.active,
      streamStatusStreamId: streamStatus?.streamId,
      processedConvoRef: processedConvoRef.current,
    });

    if (!resumableEnabled || !conversationId || conversationId === Constants.NEW_CONVO) {
      console.log('[ResumeOnLoad] Skipping - not enabled or new convo');
      return;
    }

    if (!messagesLoaded) {
      console.log('[ResumeOnLoad] Waiting for messages to load');
      return;
    }

    if (hasStaleSubmissionForDifferentConvo) {
      console.log(
        '[ResumeOnLoad] Found stale submission for different conversation, will check for resume',
        {
          staleConvoId: submissionConvoId,
          currentConvoId: conversationId,
        },
      );
    }

    if (isError) {
      if (hasActiveSubmissionForThisConvo) {
        console.log(
          '[ResumeOnLoad] Preserving active submission through transient stream status error',
          { currentConvoId: conversationId },
        );
      }
      return;
    }

    if (!isSuccess || !streamStatus || isFetching) {
      console.log('[ResumeOnLoad] Waiting for stream status query');
      return;
    }

    const generationProtocolVersion = getGenerationProtocolVersion(streamStatus);
    const isGenerationProtocolV2 = supportsGenerationProtocolV2(streamStatus);
    const handoffGenerationKey =
      isGenerationProtocolV2 &&
      streamStatus.generationHandoff === true &&
      streamStatus.createdAt != null
        ? `${conversationId}:${streamStatus.createdAt}`
        : null;
    if (
      currentSubmission == null &&
      handoffGenerationKey != null &&
      consumedHandoffGenerationRef.current !== handoffGenerationKey &&
      streamStatus.active &&
      processedConvoRef.current === conversationId
    ) {
      processedConvoRef.current = null;
    }

    if (
      hasActiveSubmissionForThisConvo &&
      activeStreamStatusMatchesSubmission(streamStatus, currentSubmission, conversationId)
    ) {
      console.log('[ResumeOnLoad] Skipping - active submission confirmed by stream status', {
        streamId: streamStatus.streamId,
        currentConvoId: conversationId,
        generationCreatedAt: streamStatus.createdAt,
      });
      processedConvoRef.current = conversationId;
      return;
    }

    if (
      streamStatus.active &&
      streamStatus.streamId &&
      submissionConvoId == null &&
      resumeStateMatchesSubmission(streamStatus, currentSubmission)
    ) {
      console.log('[ResumeOnLoad] Skipping - active submission matches stream status', {
        streamId: streamStatus.streamId,
        currentConvoId: conversationId,
        userMessageId: currentSubmission?.userMessage?.messageId,
      });
      processedConvoRef.current = conversationId;
      return;
    }

    if (processedConvoRef.current === conversationId) {
      console.log('[ResumeOnLoad] Skipping - already processed this conversation');
      return;
    }

    if (!streamStatus.active || !streamStatus.streamId) {
      console.log('[ResumeOnLoad] No active job to resume for:', conversationId);
      if (hasActiveSubmissionForThisConvo) {
        const prior = inactiveConfirmationRef.current;
        const count = prior?.conversationId === conversationId ? prior.count + 1 : 1;
        inactiveConfirmationRef.current = { conversationId, count };
        if (count < 2) {
          console.log(
            '[ResumeOnLoad] Preserving active submission until jobless status is confirmed',
            {
              currentConvoId: conversationId,
              count,
            },
          );
          return;
        }
        clearLocalActiveSubmission(conversationId, currentSubmission);
      }
      inactiveConfirmationRef.current = null;
      const leftoverSteers = dedupeSteersById(
        streamStatus.unrecoveredSteers,
        streamStatus.resumeState?.pendingSteers,
      );
      if (conversationId && leftoverSteers.length > 0) {
        convertSteersToQueued(conversationId, leftoverSteers, {
          generationProtocolVersion,
        });
      }
      settleAppliedSteerParts(conversationId, getMessages());
      restoreSteerChips(conversationId, undefined);
      processedConvoRef.current = conversationId;
      return;
    }

    inactiveConfirmationRef.current = null;
    processedConvoRef.current = conversationId;
    if (handoffGenerationKey != null) {
      consumedHandoffGenerationRef.current = handoffGenerationKey;
    }
    if (streamStatus.createdAt != null) {
      setActiveGenerationCreatedAt(
        conversationId,
        streamStatus.createdAt,
        generationProtocolVersion,
      );
    }

    console.log('[ResumeOnLoad] Found active job, creating submission...', {
      streamId: streamStatus.streamId,
      status: streamStatus.status,
      resumeState: streamStatus.resumeState,
    });

    const messages = getMessages() || [];

    if (streamStatus.resumeState) {
      restoreResumeBranch(streamStatus.resumeState, messages, conversationId);
      restoreSteerChips(
        conversationId,
        streamStatus.resumeState.pendingSteers,
        streamStatus.createdAt,
        generationProtocolVersion,
      );
      settleAppliedSteerParts(conversationId, [
        ...messages,
        ...(streamStatus.resumeState.aggregatedContent ?? []),
      ]);
      const submission = buildSubmissionFromResumeState(
        streamStatus.resumeState,
        streamStatus.streamId,
        messages,
        conversationId,
        streamStatus.createdAt,
        generationProtocolVersion,
      );
      setSubmission(submission);
    } else {
      const lastUserMessage = [...messages].reverse().find((m) => m.isCreatedByUser);
      const submission = {
        messages,
        userMessage:
          lastUserMessage ?? ({ messageId: 'resume', conversationId, text: '' } as TMessage),
        initialResponse: {
          messageId: 'resume_',
          conversationId,
          text: '',
          content: streamStatus.aggregatedContent ?? [{ type: 'text', text: '' }],
        } as TMessage,
        conversation: {
          conversationId,
          title: 'Resumed Chat',
          endpoint: null,
        } as TConversation,
        isRegenerate: false,
        isTemporary: false,
        endpointOption: {},
        resumeStreamId: streamStatus.streamId,
        ...(streamStatus.createdAt != null && {
          resumeGenerationCreatedAt: streamStatus.createdAt,
        }),
        resumeGenerationProtocolVersion: generationProtocolVersion,
      } as TSubmission & {
        resumeStreamId: string;
        resumeGenerationCreatedAt?: number;
        resumeGenerationProtocolVersion: GenerationProtocolVersion;
      };
      setSubmission(submission);
    }
  }, [
    resumableEnabled,
    conversationId,
    messagesLoaded,
    currentSubmission,
    submissionConvoId,
    hasActiveSubmissionForThisConvo,
    hasStaleSubmissionForDifferentConvo,
    isSuccess,
    isFetching,
    isError,
    streamStatus,
    getMessages,
    setSubmission,
    restoreResumeBranch,
    restoreSteerChips,
    settleAppliedSteerParts,
    convertSteersToQueued,
    setActiveGenerationCreatedAt,
    clearLocalActiveSubmission,
  ]);
}
