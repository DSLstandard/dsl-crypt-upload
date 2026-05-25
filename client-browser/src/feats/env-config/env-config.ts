const loadEnvVar = (name: string): string => {
  if (name in import.meta.env) {
    return import.meta.env[name]
  } else {
    throw new Error(`${name} is not defined in environment variables. ${import.meta.env}`)
  }
}

export const VITE_DEFAULT_API_URL = loadEnvVar("VITE_DEFAULT_API_URL")
