// Shared frontend types. The pipeline contract (#3) adds the real card/job types here.

export interface HealthResponse {
  status: string
  ollama: string
  model: string | null
  tavily_key: boolean
}
