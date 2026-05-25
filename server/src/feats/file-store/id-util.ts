import { makeAlnumStringSchema } from "../utils/alnum-string-schema.js"

export const UPLOAD_SESSION_ID_LENGTH = 96
export const UploadSessionIdSchema = makeAlnumStringSchema(UPLOAD_SESSION_ID_LENGTH)
export type UploadSessionId = string

export const FILE_ID_LENGTH = 64
export const FileIdSchema = makeAlnumStringSchema(FILE_ID_LENGTH)
export type FileId = string
