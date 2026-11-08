import { useCallback, useEffect, useState } from 'react'
import {
  getFeed,
  getFeedDetail,
  refreshFeed,
  sendFeedFeedback,
  type FeedFeedbackAction,
  type FeedItem,
  type FeedItemDetail,
} from '../api/feed'

function feedbackFor(items: FeedItem[]): Record<string, FeedFeedbackAction[]> {
  return Object.fromEntries(items.map((item) => [item.id, item.feedback]))
}

export function useFeed() {
  const [items, setItems] = useState<FeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<FeedItemDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [feedback, setFeedback] = useState<Record<string, FeedFeedbackAction[]>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getFeed(20)
      setItems(response.items)
      setFeedback(feedbackFor(response.items))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The feed could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    getFeed(20).then(
      (response) => {
        if (active) {
          setItems(response.items)
          setFeedback(feedbackFor(response.items))
        }
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'The feed could not be loaded.')
      },
    ).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [])

  const open = useCallback(async (id: string) => {
    setDetailLoading(true)
    setError(null)
    try {
      const item = await getFeedDetail(id)
      setDetail(item)
      setFeedback((current) => ({ ...current, [id]: item.feedback }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This feed item could not be opened.')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const close = useCallback(() => setDetail(null), [])

  const respond = useCallback(async (id: string, action: FeedFeedbackAction) => {
    setError(null)
    try {
      await sendFeedFeedback(id, action)
      setFeedback((current) => ({ ...current, [id]: [...new Set([...(current[id] ?? []), action])] }))
      if (action === 'not_useful' || action === 'dismiss' || action === 'less_like_this') {
        setItems((current) => current.filter((item) => item.id !== id))
        setDetail((current) => current?.id === id ? null : current)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your feedback could not be saved.')
    }
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      await refreshFeed()
      const response = await getFeed(20)
      setItems(response.items)
      setFeedback(feedbackFor(response.items))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The feed could not be refreshed.')
    } finally {
      setRefreshing(false)
    }
  }, [])

  return {
    items,
    loading,
    refreshing,
    error,
    detail,
    detailLoading,
    feedback,
    load,
    open,
    close,
    respond,
    refresh,
  }
}
