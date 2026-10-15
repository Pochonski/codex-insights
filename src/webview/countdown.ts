export function countdown(resetAt:string|null,now=Date.now()):string{
 if(!resetAt)return 'Reset unavailable';const reset=Date.parse(resetAt);if(!Number.isFinite(reset))return 'Reset unavailable';
 const remaining=reset-now;if(remaining<=0)return 'Reset due · refresh pending';
 const seconds=Math.floor(remaining/1000),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60),secs=seconds%60;
 const pad=(n:number)=>String(n).padStart(2,'0');return days?`${days}d ${hours}h ${pad(minutes)}m ${pad(secs)}s`:`${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}
