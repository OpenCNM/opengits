"use client";

import {
 ChevronLeftIcon,
 ChevronRightIcon,
 ChevronsUpDownIcon,
} from "lucide-react";
import type * as React from "react";
import { DayPicker } from "react-day-picker";
import { cn } from "@/lib/utils";

const buttonClassNames =
  "relative flex size-(--cell-size) text-xs items-center justify-center rounded-lg text-theme-foreground not-in-data-selected:hover:bg-theme-surface disabled:pointer-events-none disabled:opacity-40 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 cursor-pointer transition-colors";

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  components: userComponents,
  mode = "single",
  ...props
}: React.ComponentProps<typeof DayPicker>): React.ReactElement {
  const defaultClassNames = {
    root: "w-fit p-3 bg-theme-surface text-theme-foreground",
    months: "relative flex flex-col sm:flex-row gap-4",
    month: "w-full space-y-3",
    month_caption: "flex justify-center items-center h-8 relative px-8",
    caption_label: "text-xs font-serif font-bold text-theme-foreground select-none",
    nav: "flex items-center justify-between absolute inset-x-0 top-0 h-8 z-10",
    button_previous:
      "w-7 h-7 flex items-center justify-center rounded-lg hover:bg-theme-bg text-theme-foreground cursor-pointer transition-colors border border-transparent hover:border-theme-border",
    button_next:
      "w-7 h-7 flex items-center justify-center rounded-lg hover:bg-theme-bg text-theme-foreground cursor-pointer transition-colors border border-transparent hover:border-theme-border",
    month_grid: "w-full border-collapse",
    weekdays: "flex justify-between w-full mb-1",
    weekday: "w-8 h-8 text-center text-xs font-serif text-theme-muted flex items-center justify-center select-none",
    weeks: "w-full space-y-1",
    week: "flex justify-between w-full",
    day: "w-8 h-8 p-0 text-center text-xs relative flex items-center justify-center",
    day_button: cn(
      "w-8 h-8 p-0 rounded-lg text-xs font-mono text-theme-foreground hover:bg-theme-bg flex items-center justify-center transition-colors cursor-pointer outline-none",
      "focus-visible:ring-2 focus-visible:ring-theme-primary focus-visible:z-10"
    ),
    selected:
      "[&>.rdp-day_button]:!bg-theme-primary [&>.rdp-day_button]:!text-theme-primary-fg [&>.rdp-day_button]:font-bold [&>.rdp-day_button]:shadow-xs",
    today:
      "[&>.rdp-day_button]:font-bold [&>.rdp-day_button]:relative [&>.rdp-day_button]:after:content-[''] [&>.rdp-day_button]:after:absolute [&>.rdp-day_button]:after:bottom-1 [&>.rdp-day_button]:after:w-1 [&>.rdp-day_button]:after:h-1 [&>.rdp-day_button]:after:rounded-full [&>.rdp-day_button]:after:bg-theme-primary [&[data-selected]>.rdp-day_button]:after:bg-theme-primary-fg",
    outside:
      "[&>.rdp-day_button]:text-theme-muted/40 [&>.rdp-day_button]:hover:text-theme-muted",
    disabled:
      "[&>.rdp-day_button]:text-theme-muted/30 [&>.rdp-day_button]:opacity-40 [&>.rdp-day_button]:pointer-events-none",
    range_end: "range-end",
    range_middle: "range-middle",
    range_start: "range-start",
    hidden: "invisible",
  };
  const mergedClassNames: typeof defaultClassNames = Object.keys(
    defaultClassNames,
  ).reduce(
    (acc, key) => {
      const userClass = classNames?.[key as keyof typeof classNames];
      const baseClass =
        defaultClassNames[key as keyof typeof defaultClassNames];

      acc[key as keyof typeof defaultClassNames] = userClass
        ? cn(baseClass, userClass)
        : baseClass;

      return acc;
    },
    { ...defaultClassNames } as typeof defaultClassNames,
  );

  const defaultComponents = {
    Chevron: ({
      className,
      orientation,
      ...props
    }: {
      className?: string;
      orientation?: "left" | "right" | "up" | "down";
    }): React.ReactElement => {
      if (orientation === "left") {
        return (
          <ChevronLeftIcon
            className={cn(className, "w-4 h-4 text-theme-foreground")}
            {...props}
            aria-hidden="true"
          />
        );
      }

      if (orientation === "right") {
        return (
          <ChevronRightIcon
            className={cn(className, "w-4 h-4 text-theme-foreground")}
            {...props}
            aria-hidden="true"
          />
        );
      }

      return (
        <ChevronsUpDownIcon
          className={className}
          {...props}
          aria-hidden="true"
        />
      );
    },
  };

  const mergedComponents = {
    ...defaultComponents,
    ...userComponents,
  };

  const dayPickerProps = {
    className: cn(
      "w-fit p-3 bg-theme-surface text-theme-foreground border border-theme-border rounded-xl shadow-lg",
      className,
    ),
    classNames: mergedClassNames,
    components: mergedComponents,
    "data-slot": "calendar",
    formatters: {
      formatMonthDropdown: (date: Date) =>
        date.toLocaleString("default", { month: "short" }),
    } as React.ComponentProps<typeof DayPicker>["formatters"],
    mode,
    showOutsideDays,
    ...props,
  };

  return (
    <DayPicker
      {...(dayPickerProps as React.ComponentProps<typeof DayPicker>)}
    />
  );
}
