import { Document } from 'mongoose';

export interface PlanLimits {
  maxPages: number;
  maxLayouts: number;
  maxSnippets: number;
}

export interface Plan extends Document {
  readonly name: string;
  readonly priceIds: string[];
  readonly limits: PlanLimits;
}
