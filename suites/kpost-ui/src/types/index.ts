/**
 * Shared domain types for the KPost automation framework.
 * Kept framework-agnostic so both UI page objects and API helpers can reuse the
 * same models.
 */

export type UserRole = 'standard' | 'admin';

/**
 * KPost is a modular super-app. These are the module entries offered by the
 * Quick Access launcher, transcribed from the live app's accessible names
 * (e.g. `button "K KMail Open inbox and mails Open"`). Used to drive type-safe
 * module navigation from `AppShellPage`.
 *
 * The left icon rail exposes a near-identical set, minus "KDOC" and
 * "My Profile" — see `AppShellPage.RAIL_ICON_CLASS`.
 *
 * "KPay" is the odd one out: it appears in the rail (`icon-KP_12-KWallet`) and
 * in the rail's expanded labels, but is NOT offered by the launcher, its rail
 * entry does not navigate, and every plausible route (`/kpay`, `/kwallet`,
 * `/pay`) renders the 404 page — the module is not implemented yet
 * (KPOST-KPAY-001). It is typed here so `KPayPage` can cover that contract.
 */
export type KPostModule =
  | 'Home'
  | 'Write Mail'
  | 'KMail'
  | 'Katchup'
  | 'Kall'
  | 'KDirectory'
  | 'KCloud'
  | 'KBooking'
  | 'KDOC'
  | 'KEcommerce'
  | 'KNews'
  | 'KPay'
  | 'Settings'
  | 'My Profile';

export interface User {
  email: string;
  password: string;
  displayName?: string;
  role: UserRole;
}

export type PostVisibility = 'public' | 'followers' | 'private';

/**
 * NOTE: legacy. The blog-style post domain belonged to the scaffolded specs that
 * have been removed. It is retained only because `data/factories/postFactory.ts`,
 * `data/posts.json`, and the API seeding helpers still reference it. Delete all
 * four together once you're sure nothing needs a generic seed-and-teardown
 * example to copy from.
 */
export interface Post {
  title: string;
  body: string;
  tags: string[];
  visibility: PostVisibility;
}

/** Shape of an in-app toast notification the UI surfaces to users. */
export interface Toast {
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}
