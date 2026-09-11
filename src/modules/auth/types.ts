export type UserRole = 'admin' | 'attendant';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  image?: string | null;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: Date;
}
