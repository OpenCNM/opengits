"use client";

import * as React from "react";
import { Calendar as CalendarIcon, Clock, X, Check } from "lucide-react";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import * as m from "@/paraglide/messages";

export interface DateTimePickerProps {
  value?: string; // "YYYY-MM-DDTHH:mm" or ISO string
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  showTime?: boolean;
  disabled?: boolean;
  side?: "top" | "bottom" | "right" | "left";
  align?: "start" | "center" | "end";
}

function padZero(num: number): string {
  return num < 10 ? `0${num}` : `${num}`;
}

function formatDateString(date: Date, showTime: boolean, hour: number, minute: number): string {
  const y = date.getFullYear();
  const m = padZero(date.getMonth() + 1);
  const d = padZero(date.getDate());
  if (!showTime) {
    return `${y}-${m}-${d}`;
  }
  const h = padZero(hour);
  const min = padZero(minute);
  return `${y}-${m}-${d}T${h}:${min}`;
}

function parseDateValue(value?: string): { date?: Date; hour: number; minute: number } {
  if (!value) {
    return { date: undefined, hour: 0, minute: 0 };
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return { date: undefined, hour: 0, minute: 0 };
  }
  return {
    date: d,
    hour: d.getHours(),
    minute: d.getMinutes(),
  };
}

export function DateTimePicker({
  value,
  onChange,
  placeholder,
  className,
  showTime = true,
  disabled = false,
  side = "bottom",
  align = "start",
}: DateTimePickerProps) {
  const resolvedPlaceholder = placeholder ?? m.datepicker_select_datetime();
  const [open, setOpen] = React.useState(false);
  const parsed = React.useMemo(() => parseDateValue(value), [value]);

  const [selectedDate, setSelectedDate] = React.useState<Date | undefined>(parsed.date);
  const [selectedHour, setSelectedHour] = React.useState<number>(parsed.hour);
  const [selectedMinute, setSelectedMinute] = React.useState<number>(parsed.minute);

  React.useEffect(() => {
    setSelectedDate(parsed.date);
    setSelectedHour(parsed.hour);
    setSelectedMinute(parsed.minute);
  }, [parsed]);

  const handleSelectDay = (date: Date | undefined) => {
    setSelectedDate(date);
    if (!date) {
      onChange("");
      return;
    }
    if (!showTime) {
      onChange(formatDateString(date, false, 0, 0));
      setOpen(false);
    } else {
      onChange(formatDateString(date, true, selectedHour, selectedMinute));
    }
  };

  const handleHourChange = (newHour: number) => {
    setSelectedHour(newHour);
    if (selectedDate) {
      onChange(formatDateString(selectedDate, true, newHour, selectedMinute));
    }
  };

  const handleMinuteChange = (newMinute: number) => {
    setSelectedMinute(newMinute);
    if (selectedDate) {
      onChange(formatDateString(selectedDate, true, selectedHour, newMinute));
    }
  };

  const handleClear = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedDate(undefined);
    onChange("");
    setOpen(false);
  };

  const handleQuickToday = () => {
    const today = new Date();
    setSelectedDate(today);
    onChange(formatDateString(today, showTime, selectedHour, selectedMinute));
  };

  const handleQuickDaysLater = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    setSelectedDate(d);
    onChange(formatDateString(d, showTime, selectedHour, selectedMinute));
  };

  const displayFormatted = React.useMemo(() => {
    if (!selectedDate) return "";
    const y = selectedDate.getFullYear();
    const m = padZero(selectedDate.getMonth() + 1);
    const d = padZero(selectedDate.getDate());
    if (!showTime) {
      return `${y}-${m}-${d}`;
    }
    return `${y}-${m}-${d} ${padZero(selectedHour)}:${padZero(selectedMinute)}`;
  }, [selectedDate, showTime, selectedHour, selectedMinute]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative inline-block w-full", className)}>
        <PopoverTrigger
          disabled={disabled}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 bg-theme-bg border border-theme-border rounded-lg text-xs font-mono text-theme-foreground transition-all cursor-pointer select-none",
            open ? "border-theme-primary ring-2 ring-theme-primary/20" : "hover:border-theme-border/80",
            disabled && "opacity-50 pointer-events-none"
          )}
        >
          <div className="flex items-center gap-2 truncate">
            <CalendarIcon className="w-3.5 h-3.5 text-theme-muted shrink-0" />
            <span className={selectedDate ? "text-theme-foreground font-semibold" : "text-theme-muted font-sans"}>
              {displayFormatted || resolvedPlaceholder}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {selectedDate && !disabled && (
              <button
                type="button"
                onClick={handleClear}
                className="p-0.5 rounded hover:bg-theme-surface text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
                title={m.search_clear()}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </PopoverTrigger>

        <PopoverPopup
          side={side}
          align={align}
          sideOffset={8}
          className="p-0 bg-theme-surface border border-theme-border rounded-xl shadow-2xl z-50 overflow-hidden"
        >
          <div className="p-3 space-y-3">
            {/* CossUI Calendar */}
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={handleSelectDay}
              className="p-0 bg-transparent border-none shadow-none"
            />

            {/* Time Selector */}
            {showTime && (
              <div className="pt-2 border-t border-theme-border/70 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-serif text-theme-muted">
                  <Clock className="w-3.5 h-3.5 text-theme-primary" />
                  <span>{m.mcp_log_th_time()}</span>
                </div>

                <div className="flex items-center gap-1 font-mono text-xs">
                  <select
                    value={selectedHour}
                    onChange={(e) => handleHourChange(Number(e.target.value))}
                    className="px-2 py-1 bg-theme-bg border border-theme-border rounded-md text-theme-foreground focus:outline-none focus:border-theme-primary cursor-pointer text-xs"
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {padZero(i)} {m.ui_time_hour()}
                      </option>
                    ))}
                  </select>
                  <span className="text-theme-muted font-bold">:</span>
                  <select
                    value={selectedMinute}
                    onChange={(e) => handleMinuteChange(Number(e.target.value))}
                    className="px-2 py-1 bg-theme-bg border border-theme-border rounded-md text-theme-foreground focus:outline-none focus:border-theme-primary cursor-pointer text-xs"
                  >
                    {Array.from({ length: 60 }, (_, i) => (
                      <option key={i} value={i}>
                        {padZero(i)} {m.ui_time_minute()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Quick Actions & Confirm */}
            <div className="pt-2 border-t border-theme-border/70 flex items-center justify-between gap-1 text-xs">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleQuickToday}
                  className="px-2 py-1 rounded bg-theme-bg border border-theme-border hover:border-theme-primary text-theme-foreground transition-all cursor-pointer font-serif"
                >
                  {m.ui_date_today()}
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickDaysLater(7)}
                  className="px-2 py-1 rounded bg-theme-bg border border-theme-border hover:border-theme-primary text-theme-foreground transition-all cursor-pointer font-serif"
                >
                  {m.ui_date_7_days_later()}
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickDaysLater(30)}
                  className="px-2 py-1 rounded bg-theme-bg border border-theme-border hover:border-theme-primary text-theme-foreground transition-all cursor-pointer font-serif"
                >
                  {m.ui_date_30_days_later()}
                </button>
              </div>

              <div className="flex items-center gap-1">
                {selectedDate && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="px-2 py-1 rounded text-rose-600 hover:bg-rose-500/10 transition-all cursor-pointer font-serif"
                  >
                    {m.search_clear()}
                  </button>
                )}
                <Button
                  size="xs"
                  onClick={() => setOpen(false)}
                  className="px-3 py-1 bg-theme-primary text-theme-primary-fg hover:bg-theme-primary/90 font-bold rounded cursor-pointer shadow-2xs inline-flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  <span>{m.common_confirm()}</span>
                </Button>
              </div>
            </div>
          </div>
        </PopoverPopup>
      </div>
    </Popover>
  );
}
