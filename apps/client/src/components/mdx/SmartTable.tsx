import React from 'react';
import { cn } from '@/lib/utils';

export interface SmartTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  children?: React.ReactNode;
  className?: string;
}

export default function SmartTable({ children, className, ...props }: SmartTableProps) {
  return (
    <div className="relative w-full overflow-x-auto my-6 prose-no-margin">
      <table
        className={cn(
          'w-full text-left text-sm',
          className
        )}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}
