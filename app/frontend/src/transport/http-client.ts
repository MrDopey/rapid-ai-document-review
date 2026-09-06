import {
  AcceptRemainingResponse,
  ApplyEditResponse,
  ClearPrimaryResponse,
  CloseConversationRequest,
  CloseConversationResponse,
  ConversationDto,
  CreateConversationRequest,
  CreateDocumentRequest,
  CreateDocumentResponse,
  DesignatePrimaryRequest,
  DesignatePrimaryResponse,
  DiscardConversationResponse,
  DropEditResponse,
  DropRemainingResponse,
  ErrorEnvelope,
  ExportDocumentQuery,
  GetConversationResponse,
  GetDocumentResponse,
  ListConversationsResponse,
  ListEditsResponse,
  ListRevisionsResponse,
  PatchDocumentRequest,
  PatchDocumentResponse,
  PreviewEditResponse,
  PrimaryWhenBusy,
  RefreshSendResponse,
  RenameConversationRequest,
  RestoreRevisionResponse,
  RetryResponse,
  ReviewConversationResponse,
  SendMessageRequest,
  SendMessageResponse,
  SystemPromptDto,
  UserSettingsDto,
  UserSettingsPatch,
} from '@rapid-ai-document-review/shared/contracts/http';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** `cursor`/`limit` → query-string builder shared by every paginated list endpoint
 *  (`listRevisions`, `listConversations`), rendered as `""` or `"?cursor=...&limit=..."`. */
function buildPageQuery(params: { cursor?: string; limit?: number }): string {
  const search = new URLSearchParams();
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (json: unknown) => T,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = ErrorEnvelope.safeParse(json);
    if (envelope.success) {
      throw new ApiError(
        response.status,
        envelope.data.error.code,
        envelope.data.error.message,
        envelope.data.error.details,
      );
    }
    throw new ApiError(
      response.status,
      'UNKNOWN',
      `Request to ${path} failed with ${response.status}`,
    );
  }
  return parse(json);
}

export const httpClient = {
  async createDocument(input: CreateDocumentRequest) {
    CreateDocumentRequest.parse(input);
    return request('/api/document', { method: 'POST', body: JSON.stringify(input) }, (j) =>
      CreateDocumentResponse.parse(j),
    );
  },

  async getDocument() {
    try {
      return await request('/api/document', undefined, (j) => GetDocumentResponse.parse(j));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  async patchDocument(input: {
    baseRevision?: number;
    changes?: { from: number; to: number; insert: string }[];
    title?: string;
  }) {
    PatchDocumentRequest.parse(input);
    return request('/api/document', { method: 'PATCH', body: JSON.stringify(input) }, (j) =>
      PatchDocumentResponse.parse(j),
    );
  },

  async exportDocument(query: { revision?: number; download?: boolean } = {}) {
    const parsed = ExportDocumentQuery.parse(query);
    const params = new URLSearchParams();
    if (parsed.revision !== undefined) params.set('revision', String(parsed.revision));
    if (parsed.download) params.set('download', '1');
    const qs = params.toString();
    const response = await fetch(`/api/document/export${qs ? `?${qs}` : ''}`);
    if (!response.ok) {
      throw new ApiError(response.status, 'UNKNOWN', 'Export failed');
    }
    return response.text();
  },

  async listRevisions(params: { cursor?: string; limit?: number } = {}) {
    return request(`/api/revisions${buildPageQuery(params)}`, undefined, (j) =>
      ListRevisionsResponse.parse(j),
    );
  },

  async restoreRevision(revision: number) {
    return request(`/api/revisions/${revision}/restore`, { method: 'POST' }, (j) =>
      RestoreRevisionResponse.parse(j),
    );
  },

  async listConversations(params: { cursor?: string; limit?: number } = {}) {
    return request(`/api/conversations${buildPageQuery(params)}`, undefined, (j) =>
      ListConversationsResponse.parse(j),
    );
  },

  async getConversation(id: string) {
    return request(`/api/conversations/${id}`, undefined, (j) => GetConversationResponse.parse(j));
  },

  async sendMessage(id: string, message: string) {
    const body: SendMessageRequest = { message };
    return request(
      `/api/conversations/${id}/send`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => SendMessageResponse.parse(j),
    );
  },

  async refreshAndSend(id: string, message: string) {
    const body: SendMessageRequest = { message };
    return request(
      `/api/conversations/${id}/refresh-send`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => RefreshSendResponse.parse(j),
    );
  },

  async retryConversation(id: string) {
    return request(`/api/conversations/${id}/retry`, { method: 'POST' }, (j) =>
      RetryResponse.parse(j),
    );
  },

  async branchConversation(input: CreateConversationRequest) {
    CreateConversationRequest.parse(input);
    return request('/api/conversations', { method: 'POST', body: JSON.stringify(input) }, (j) =>
      ConversationDto.parse(j),
    );
  },

  async renameConversation(id: string, name: string) {
    const body: RenameConversationRequest = { name };
    return request(
      `/api/conversations/${id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      (j) => ConversationDto.parse(j),
    );
  },

  async closeConversation(id: string, foldSummaryIntoParent = false) {
    const body: CloseConversationRequest = { foldSummaryIntoParent };
    return request(
      `/api/conversations/${id}/close`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => CloseConversationResponse.parse(j),
    );
  },

  async reviewConversation(id: string) {
    return request(`/api/conversations/${id}/review`, { method: 'POST' }, (j) =>
      ReviewConversationResponse.parse(j),
    );
  },

  async designatePrimary(id: string, whenBusy?: PrimaryWhenBusy) {
    const body: DesignatePrimaryRequest = { whenBusy };
    return request(
      `/api/conversations/${id}/primary`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => DesignatePrimaryResponse.parse(j),
    );
  },

  async clearPrimary(id: string) {
    return request(`/api/conversations/${id}/primary`, { method: 'DELETE' }, (j) =>
      ClearPrimaryResponse.parse(j),
    );
  },

  /** 005-canvas-conversation-threads follow-up: physically discards an untouched branch
   *  placeholder — see `ConversationService.discardIfEmpty`'s doc comment for eligibility. */
  async discardConversation(id: string) {
    return request(`/api/conversations/${id}`, { method: 'DELETE' }, (j) =>
      DiscardConversationResponse.parse(j),
    );
  },

  async listEdits(conversationId: string) {
    return request(`/api/conversations/${conversationId}/edits`, undefined, (j) =>
      ListEditsResponse.parse(j),
    );
  },

  async previewEdit(editId: string) {
    return request(`/api/edits/${editId}/preview`, undefined, (j) => PreviewEditResponse.parse(j));
  },

  async applyEdit(editId: string) {
    return request(`/api/edits/${editId}/apply`, { method: 'POST' }, (j) =>
      ApplyEditResponse.parse(j),
    );
  },

  async dropEdit(editId: string) {
    return request(`/api/edits/${editId}/drop`, { method: 'POST' }, (j) =>
      DropEditResponse.parse(j),
    );
  },

  async acceptRemaining(conversationId: string) {
    return request(
      `/api/conversations/${conversationId}/edits/accept-remaining`,
      { method: 'POST' },
      (j) => AcceptRemainingResponse.parse(j),
    );
  },

  async dropRemaining(conversationId: string) {
    return request(
      `/api/conversations/${conversationId}/edits/drop-remaining`,
      { method: 'POST' },
      (j) => DropRemainingResponse.parse(j),
    );
  },

  async getSettings() {
    return request('/api/settings', undefined, (j) => UserSettingsDto.parse(j));
  },

  async patchSettings(patch: UserSettingsPatch) {
    return request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }, (j) =>
      UserSettingsDto.parse(j),
    );
  },

  async getSystemPrompt() {
    return request('/api/system-prompt', undefined, (j) => SystemPromptDto.parse(j));
  },
};
