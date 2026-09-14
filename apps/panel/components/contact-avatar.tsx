"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

type ContactAvatarProps = {
  name: string;
  src?: string | null;
  className?: string;
};

export function ContactAvatar({ name, src, className = "" }: ContactAvatarProps) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().slice(0, 1).toUpperCase() || "?";

  useEffect(() => setFailed(false), [src]);

  return (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--border)] bg-transparent font-semibold text-[var(--body)] ${className}`}
      aria-hidden="true"
    >
      {src && !failed ? (
        <Image
          src={src}
          alt=""
          width={96}
          height={96}
          unoptimized
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : initial}
    </span>
  );
}
