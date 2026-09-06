export const SCHEMA_VERSION = 1;

export type Meta = {
  schemaVersion: number;
  sourceTool: string;
  sourceVersion: string | null;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
  /**
   * The tool currently holding the session — stamped by `handoff switch` each
   * time it hands off. Unlike `sourceTool` (fixed at `init`), this tracks the
   * *departing* tool across successive switches, so handoff-tax direction is
   * classified against the tool actually handing off. Optional: absent on meta
   * written before this field existed, in which case callers fall back to
   * `sourceTool`.
   */
  lastActiveTool?: string | null;
};

export type FileEntry = {
  path: string;
  size: number;
  modifiedAt: string;
  hash: string;
};

export type FilesManifest = {
  generatedAt: string;
  files: FileEntry[];
};
