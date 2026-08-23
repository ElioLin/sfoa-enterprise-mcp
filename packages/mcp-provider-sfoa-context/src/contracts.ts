import type {
  DiagnosticQueryEvidence,
  DiagnosticQueryInput,
  MetadataComponentContext,
  MetadataContextInput,
} from './schemas.js';

export interface DiagnosticToolingQueryExecutor {
  execute(input: DiagnosticQueryInput): Promise<DiagnosticQueryEvidence>;
}

export interface MetadataComponentContextExecutor {
  execute(input: MetadataContextInput): Promise<MetadataComponentContext>;
}
