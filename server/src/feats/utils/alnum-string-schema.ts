import { Schema } from "effect"
import { isAlnumString } from "./alnum.js"

/**
 * Makes an Effect schema for alphanumeric strings of a specific length.
 */
export function makeAlnumStringSchema(len: number) {
  return Schema.String.pipe(
    Schema.filter((str: string) => {
      if (str.length !== len) {
        return false
      }

      if (!isAlnumString(str)) {
        return false
      }

      return true
    })
  )
}