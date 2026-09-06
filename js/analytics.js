/**
 * Vercel Web Analytics Initialization
 * 
 * This project uses the script tag approach for Vercel Web Analytics,
 * which is the recommended method for vanilla HTML/JavaScript projects.
 * 
 * The analytics are loaded via script tags in the HTML files:
 * - /_vercel/insights/script.js (automatically served by Vercel)
 * 
 * This file is provided as a reference for potential future enhancements
 * using the @vercel/analytics package.
 */

// Analytics is automatically initialized via script tags in HTML.
// No additional initialization needed for basic functionality.

// Optional: Track custom events
// Usage: trackEvent('event_name', { property: 'value' })
export function trackEvent(eventName, properties = {}) {
  if (typeof window !== 'undefined' && window.va) {
    window.va('event', eventName, properties);
  }
}

// Optional: Track page views manually (useful for SPAs)
// Usage: trackPageView('/custom-path')
export function trackPageView(path) {
  if (typeof window !== 'undefined' && window.va) {
    window.va('pageview', { path });
  }
}

// Export for potential future use
export default {
  trackEvent,
  trackPageView
};
