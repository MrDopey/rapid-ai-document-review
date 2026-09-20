import {
  AcceptRemainingResponse,
  ApplyEditResponse,
  BranchThreadRequest,
  ClearPrimaryResponse,
  CloseConversationRequest,
  CloseConversationResponse,
  ConversationDto,
  CreateConversationRequest,
  CreateDocumentRequest,
  CreateDocumentResponse,
  DeleteDocumentResponse,
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
  ListDocumentsResponse,
  ListEditsResponse,
  ListRevisionsResponse,
  MarkThreadDoneResponse,
  PatchDocumentRequest,
  PatchDocumentResponse,
  PreviewEditResponse,
  PrimaryWhenBusy,
  RefreshSendResponse,
  RenameConversationRequest,
  RenameDocumentRequest,
  ReopenThreadResponse,
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
  async listDocuments() {
    return request('/api/documents', undefined, (j) => ListDocumentsResponse.parse(j));
  },

  async createDocument(input: CreateDocumentRequest) {
    CreateDocumentRequest.parse(input);
    return request('/api/documents', { method: 'POST', body: JSON.stringify(input) }, (j) =>
      CreateDocumentResponse.parse(j),
    );
  },

  async getDocument(documentId: string) {
    try {
      return await request(`/api/documents/${documentId}`, undefined, (j) =>
        GetDocumentResponse.parse(j),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  async patchDocument(
    documentId: string,
    input: {
      baseRevision?: number;
      changes?: { from: number; to: number; insert: string }[];
      title?: string;
    },
  ) {
    PatchDocumentRequest.parse(input);
    return request(
      `/api/documents/${documentId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
      (j) => PatchDocumentResponse.parse(j),
    );
  },

  async renameDocument(documentId: string, title: string) {
    const body: RenameDocumentRequest = { title };
    return request(
      `/api/documents/${documentId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      (j) => PatchDocumentResponse.parse(j),
    );
  },

  async deleteDocument(documentId: string) {
    return request(`/api/documents/${documentId}`, { method: 'DELETE' }, (j) =>
      DeleteDocumentResponse.parse(j),
    );
  },

  async exportDocument(documentId: string, query: { revision?: number; download?: boolean } = {}) {
    const parsed = ExportDocumentQuery.parse(query);
    const params = new URLSearchParams();
    if (parsed.revision !== undefined) params.set('revision', String(parsed.revision));
    if (parsed.download) params.set('download', '1');
    const qs = params.toString();
    const response = await fetch(`/api/documents/${documentId}/export${qs ? `?${qs}` : ''}`);
    if (!response.ok) {
      throw new ApiError(response.status, 'UNKNOWN', 'Export failed');
    }
    return response.text();
  },

  async listRevisions(documentId: string, params: { cursor?: string; limit?: number } = {}) {
    return request(
      `/api/documents/${documentId}/revisions${buildPageQuery(params)}`,
      undefined,
      (j) => ListRevisionsResponse.parse(j),
    );
  },

  async restoreRevision(documentId: string, revision: number) {
    return request(
      `/api/documents/${documentId}/revisions/${revision}/restore`,
      { method: 'POST' },
      (j) => RestoreRevisionResponse.parse(j),
    );
  },

  async listConversations(documentId: string, params: { cursor?: string; limit?: number } = {}) {
    return request(
      `/api/documents/${documentId}/conversations${buildPageQuery(params)}`,
      undefined,
      (j) => ListConversationsResponse.parse(j),
    );
  },

  async getConversation(documentId: string, id: string) {
    return request(`/api/documents/${documentId}/conversations/${id}`, undefined, (j) =>
      GetConversationResponse.parse(j),
    );
  },

  async sendMessage(documentId: string, id: string, message: string) {
    const body: SendMessageRequest = { message };
    return request(
      `/api/documents/${documentId}/conversations/${id}/send`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => SendMessageResponse.parse(j),
    );
  },

  async refreshAndSend(documentId: string, id: string, message: string) {
    const body: SendMessageRequest = { message };
    return request(
      `/api/documents/${documentId}/conversations/${id}/refresh-send`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => RefreshSendResponse.parse(j),
    );
  },

  async retryConversation(documentId: string, id: string) {
    return request(
      `/api/documents/${documentId}/conversations/${id}/retry`,
      { method: 'POST' },
      (j) => RetryResponse.parse(j),
    );
  },

  async branchConversation(documentId: string, input: CreateConversationRequest) {
    CreateConversationRequest.parse(input);
    return request(
      `/api/documents/${documentId}/conversations`,
      { method: 'POST', body: JSON.stringify(input) },
      (j) => ConversationDto.parse(j),
    );
  },

  async renameConversation(documentId: string, id: string, name: string) {
    const body: RenameConversationRequest = { name };
    return request(
      `/api/documents/${documentId}/conversations/${id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      (j) => ConversationDto.parse(j),
    );
  },

  async closeConversation(documentId: string, id: string, foldSummaryIntoParent = false) {
    const body: CloseConversationRequest = { foldSummaryIntoParent };
    return request(
      `/api/documents/${documentId}/conversations/${id}/close`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => CloseConversationResponse.parse(j),
    );
  },

  async reviewConversation(documentId: string, id: string) {
    return request(
      `/api/documents/${documentId}/conversations/${id}/review`,
      { method: 'POST' },
      (j) => ReviewConversationResponse.parse(j),
    );
  },

  async designatePrimary(documentId: string, id: string, whenBusy?: PrimaryWhenBusy) {
    const body: DesignatePrimaryRequest = { whenBusy };
    return request(
      `/api/documents/${documentId}/conversations/${id}/primary`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => DesignatePrimaryResponse.parse(j),
    );
  },

  async clearPrimary(documentId: string, id: string) {
    return request(
      `/api/documents/${documentId}/conversations/${id}/primary`,
      { method: 'DELETE' },
      (j) => ClearPrimaryResponse.parse(j),
    );
  },

  /** 005-canvas-conversation-threads follow-up: physically discards an untouched branch
   *  placeholder — see `ConversationService.discardIfEmpty`'s doc comment for eligibility. */
  async discardConversation(documentId: string, id: string) {
    return request(`/api/documents/${documentId}/conversations/${id}`, { method: 'DELETE' }, (j) =>
      DiscardConversationResponse.parse(j),
    );
  },

  async listEdits(documentId: string, conversationId: string) {
    return request(
      `/api/documents/${documentId}/conversations/${conversationId}/edits`,
      undefined,
      (j) => ListEditsResponse.parse(j),
    );
  },

  async previewEdit(documentId: string, editId: string) {
    return request(`/api/documents/${documentId}/edits/${editId}/preview`, undefined, (j) =>
      PreviewEditResponse.parse(j),
    );
  },

  async applyEdit(documentId: string, editId: string) {
    return request(`/api/documents/${documentId}/edits/${editId}/apply`, { method: 'POST' }, (j) =>
      ApplyEditResponse.parse(j),
    );
  },

  async dropEdit(documentId: string, editId: string) {
    return request(`/api/documents/${documentId}/edits/${editId}/drop`, { method: 'POST' }, (j) =>
      DropEditResponse.parse(j),
    );
  },

  async acceptRemaining(documentId: string, conversationId: string) {
    return request(
      `/api/documents/${documentId}/conversations/${conversationId}/edits/accept-remaining`,
      { method: 'POST' },
      (j) => AcceptRemainingResponse.parse(j),
    );
  },

  async dropRemaining(documentId: string, conversationId: string) {
    return request(
      `/api/documents/${documentId}/conversations/${conversationId}/edits/drop-remaining`,
      { method: 'POST' },
      (j) => DropRemainingResponse.parse(j),
    );
  },

  // ---- Linear thread mode (011-linear-thread-mode) ----

  async listThreads(documentId: string, params: { cursor?: string; limit?: number } = {}) {
    return request(
      `/api/documents/${documentId}/threads${buildPageQuery(params)}`,
      undefined,
      (j) => ListConversationsResponse.parse(j),
    );
  },

  async getThreadMessages(documentId: string, id: string) {
    return request(`/api/documents/${documentId}/threads/${id}/messages`, undefined, (j) =>
      GetConversationResponse.parse(j),
    );
  },

  async sendThreadMessage(documentId: string, id: string, message: string) {
    const body: SendMessageRequest = { message };
    return request(
      `/api/documents/${documentId}/threads/${id}/send`,
      { method: 'POST', body: JSON.stringify(body) },
      (j) => SendMessageResponse.parse(j),
    );
  },

  async branchThread(documentId: string, id: string, input: BranchThreadRequest) {
    BranchThreadRequest.parse(input);
    return request(
      `/api/documents/${documentId}/threads/${id}/branch`,
      { method: 'POST', body: JSON.stringify(input) },
      (j) => ConversationDto.parse(j),
    );
  },

  async markThreadDone(documentId: string, id: string) {
    return request(`/api/documents/${documentId}/threads/${id}/done`, { method: 'POST' }, (j) =>
      MarkThreadDoneResponse.parse(j),
    );
  },

  async reopenThread(documentId: string, id: string) {
    return request(`/api/documents/${documentId}/threads/${id}/reopen`, { method: 'POST' }, (j) =>
      ReopenThreadResponse.parse(j),
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
