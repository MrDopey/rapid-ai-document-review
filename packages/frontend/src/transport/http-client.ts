import {
  CreateDocumentRequest,
  CreateDocumentResponse,
  ErrorEnvelope,
  ExportDocumentQuery,
  GetConversationResponse,
  GetDocumentResponse,
  ListConversationsResponse,
  ListRevisionsResponse,
  PatchDocumentRequest,
  PatchDocumentResponse,
  RestoreRevisionResponse,
  RetryResponse,
  SendMessageRequest,
  SendMessageResponse,
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
      throw new ApiError(response.status, envelope.data.error.code, envelope.data.error.message, envelope.data.error.details);
    }
    throw new ApiError(response.status, 'UNKNOWN', `Request to ${path} failed with ${response.status}`);
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

  async patchDocument(input: { baseRevision?: number; changes?: { from: number; to: number; insert: string }[]; title?: string }) {
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
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request(`/api/revisions${qs ? `?${qs}` : ''}`, undefined, (j) =>
      ListRevisionsResponse.parse(j),
    );
  },

  async restoreRevision(revision: number) {
    return request(`/api/revisions/${revision}/restore`, { method: 'POST' }, (j) =>
      RestoreRevisionResponse.parse(j),
    );
  },

  async listConversations(params: { cursor?: string; limit?: number } = {}) {
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request(`/api/conversations${qs ? `?${qs}` : ''}`, undefined, (j) =>
      ListConversationsResponse.parse(j),
    );
  },

  async getConversation(id: string) {
    return request(`/api/conversations/${id}`, undefined, (j) => GetConversationResponse.parse(j));
  },

  async sendMessage(id: string, message: string) {
    const body: SendMessageRequest = { message };
    return request(`/api/conversations/${id}/send`, { method: 'POST', body: JSON.stringify(body) }, (j) =>
      SendMessageResponse.parse(j),
    );
  },

  async retryConversation(id: string) {
    return request(`/api/conversations/${id}/retry`, { method: 'POST' }, (j) => RetryResponse.parse(j));
  },

  async getSettings() {
    return request('/api/settings', undefined, (j) => UserSettingsDto.parse(j));
  },

  async patchSettings(patch: UserSettingsPatch) {
    return request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }, (j) =>
      UserSettingsDto.parse(j),
    );
  },
};
