export interface Status {
  network: string;
  dripTaz: number;
  cooldownSeconds: number;
  sender: string;
  turnstileEnabled: boolean;
  balanceTaz: number | null;
  empty: boolean;
  donationAddress: string;
  backend: { reachable: boolean; endpoint: string };
}

export interface ThrowawayAccount {
  type: "transparent" | "shielded";
  shielded: boolean;
  address: string;
  secret: string;
  secretLabel: string;
  mock: boolean;
  warning: string;
}
