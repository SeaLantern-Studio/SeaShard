export interface ApplicationHeaderHostIndicator {
  readonly label: string;
  readonly state: "connected" | "attention" | "error";
}
