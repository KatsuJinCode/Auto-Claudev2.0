import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility function to merge Tailwind CSS classes
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Calculate progress percentage from subtasks
 * @param subtasks Array of subtasks with status
 * @returns Progress percentage (0-100)
 */
export function calculateProgress(subtasks: { status: string }[]): number {
  if (subtasks.length === 0) return 0;
  const completed = subtasks.filter((s) => s.status === 'completed').length;
  return Math.round((completed / subtasks.length) * 100);
}

/**
 * Format a date as a relative time string
 * @param date Date to format
 * @returns Relative time string (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(date).toLocaleDateString();
}

/**
 * Sanitize and extract plain text from markdown content.
 * Strips markdown formatting and collapses whitespace for clean display in UI.
 * @param text The text that might contain markdown
 * @param maxLength Maximum length before truncation (default: 200)
 * @returns Plain text suitable for display
 */
export function sanitizeMarkdownForDisplay(text: string, maxLength: number = 200): string {
  if (!text) return '';

  let sanitized = text
    // Remove markdown headers (# ## ### etc)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove blockquotes
    .replace(/^>\s*/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove checkbox markers
    .replace(/\[[ x]\]\s*/gi, '')
    // Collapse multiple newlines to single space
    .replace(/\n+/g, ' ')
    // Collapse multiple spaces to single space
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate if needed
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength).trim() + '...';
  }

  return sanitized;
}

/**
 * Threshold in milliseconds for considering activity as stale (5 minutes)
 */
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Threshold in milliseconds for clock skew tolerance (5 minutes in future)
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Result type for elapsed time calculation
 */
export interface ElapsedTimeResult {
  /** Formatted elapsed time string (e.g., "2m 15s") */
  formatted: string;
  /** Raw elapsed time in milliseconds */
  elapsedMs: number;
  /** Whether the timestamp is considered stale (>5 minutes old) */
  isStale: boolean;
  /** Whether the timestamp appears invalid (in future beyond tolerance) */
  isInvalid: boolean;
}

/**
 * Calculate elapsed time from a log timestamp and format as duration.
 * Used for displaying how long since the last log activity occurred.
 *
 * @param timestamp The log timestamp to calculate elapsed time from
 * @param now Optional current time for testing (defaults to Date.now())
 * @returns ElapsedTimeResult with formatted string and metadata
 *
 * @example
 * // 2 minutes and 15 seconds ago
 * formatElapsedFromTimestamp(new Date(Date.now() - 135000)) // { formatted: "2m 15s", elapsedMs: 135000, ... }
 *
 * @example
 * // Just now
 * formatElapsedFromTimestamp(new Date()) // { formatted: "0s", elapsedMs: ~0, ... }
 *
 * @example
 * // Stale timestamp (>5 min)
 * formatElapsedFromTimestamp(new Date(Date.now() - 600000)) // { formatted: "10m 0s", isStale: true, ... }
 */
export function formatElapsedFromTimestamp(
  timestamp: Date | string | null | undefined,
  now?: number
): ElapsedTimeResult {
  const currentTime = now ?? Date.now();

  // Handle null/undefined timestamps
  if (!timestamp) {
    return {
      formatted: '--',
      elapsedMs: 0,
      isStale: true,
      isInvalid: true
    };
  }

  // Parse timestamp if it's a string
  const timestampDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

  // Validate timestamp is a valid date
  if (isNaN(timestampDate.getTime())) {
    return {
      formatted: '--',
      elapsedMs: 0,
      isStale: true,
      isInvalid: true
    };
  }

  const elapsedMs = currentTime - timestampDate.getTime();

  // Check for clock skew (timestamp too far in future)
  if (elapsedMs < -CLOCK_SKEW_TOLERANCE_MS) {
    return {
      formatted: '--',
      elapsedMs: elapsedMs,
      isStale: false,
      isInvalid: true
    };
  }

  // Handle small negative values (minor clock skew) by treating as 0
  const adjustedElapsedMs = Math.max(0, elapsedMs);

  // Check if stale (>5 minutes)
  const isStale = adjustedElapsedMs > STALE_THRESHOLD_MS;

  // Format the elapsed time
  const formatted = formatDuration(adjustedElapsedMs);

  return {
    formatted,
    elapsedMs: adjustedElapsedMs,
    isStale,
    isInvalid: false
  };
}

/**
 * Format a duration in milliseconds as a human-readable string.
 *
 * @param ms Duration in milliseconds
 * @returns Formatted duration string (e.g., "2m 15s", "1h 30m", "5s")
 *
 * @example
 * formatDuration(5000) // "5s"
 * formatDuration(135000) // "2m 15s"
 * formatDuration(5400000) // "1h 30m"
 * formatDuration(90061000) // "1d 1h 1m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const remainingHours = hours % 24;
  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;

  // Build parts array based on what units are present
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    if (days > 0) {
      // When showing days, include hours
      parts.push(`${remainingHours}h`);
    } else {
      parts.push(`${hours}h`);
    }
  }
  if (minutes > 0 || hours > 0 || days > 0) {
    if (hours > 0 || days > 0) {
      // When showing hours/days, include minutes
      parts.push(`${remainingMinutes}m`);
    } else {
      parts.push(`${minutes}m`);
    }
  }

  // Only show seconds if less than 1 hour (for cleaner display of long durations)
  if (hours === 0 && days === 0) {
    if (minutes > 0) {
      parts.push(`${remainingSeconds}s`);
    } else {
      // Just seconds (or 0s)
      parts.push(`${seconds}s`);
    }
  }

  return parts.join(' ') || '0s';
}
