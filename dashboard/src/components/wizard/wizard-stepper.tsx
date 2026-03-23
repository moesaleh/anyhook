"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WizardStep {
  id: number;
  label: string;
  description: string;
}

interface WizardStepperProps {
  steps: WizardStep[];
  currentStep: number;
}

export function WizardStepper({ steps, currentStep }: WizardStepperProps) {
  return (
    <nav aria-label="Wizard progress" className="mb-8">
      <ol className="flex items-center">
        {steps.map((step, index) => {
          const isCompleted = currentStep > step.id;
          const isCurrent = currentStep === step.id;
          const isLast = index === steps.length - 1;

          return (
            <li
              key={step.id}
              className={cn("flex items-center", !isLast && "flex-1")}
            >
              <div className="flex items-center gap-3">
                {/* Step circle */}
                <div
                  className={cn(
                    "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition-all duration-200",
                    isCompleted
                      ? "border-indigo-600 bg-indigo-600 text-white"
                      : isCurrent
                        ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                        : "border-neutral-300 bg-white text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-600"
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    step.id
                  )}
                </div>

                {/* Label + description (hidden on small screens) */}
                <div className="hidden sm:block">
                  <p
                    className={cn(
                      "text-sm font-medium leading-tight",
                      isCurrent
                        ? "text-indigo-700 dark:text-indigo-300"
                        : isCompleted
                          ? "text-neutral-900 dark:text-neutral-100"
                          : "text-neutral-400 dark:text-neutral-600"
                    )}
                  >
                    {step.label}
                  </p>
                  <p
                    className={cn(
                      "text-xs leading-tight mt-0.5",
                      isCurrent || isCompleted
                        ? "text-neutral-500"
                        : "text-neutral-400 dark:text-neutral-600"
                    )}
                  >
                    {step.description}
                  </p>
                </div>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={cn(
                    "mx-3 h-0.5 flex-1 rounded transition-colors duration-200",
                    isCompleted
                      ? "bg-indigo-600"
                      : "bg-neutral-200 dark:bg-neutral-800"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
