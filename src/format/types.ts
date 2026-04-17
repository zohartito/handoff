export const SCHEMA_VERSION = 1;

export type Meta = {
  schemaVersion: number;
  sourceTool: string;
  sourceVersion: string | null;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
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
