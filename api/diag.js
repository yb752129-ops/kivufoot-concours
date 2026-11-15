module.exports=async(req,res)=>{
  const U=process.env.SUPABASE_URL||'',K=process.env.SUPABASE_SERVICE_KEY||'';
  const out={url_ok:/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(U),url_len:U.length,key_prefix_ok:K.startsWith('sb_secret_')||K.startsWith('eyJ'),key_len:K.length,espace_cache:/\s/.test(K)||/\s/.test(U),admin_len:(process.env.ADMIN_SECRET||'').length};
  try{
    const h={apikey:K};if(K.startsWith('eyJ'))h.Authorization='Bearer '+K;
    const r=await fetch(U+'/rest/v1/config?id=eq.1',{headers:h});
    out.status=r.status;out.body=(await r.text()).slice(0,300);
  }catch(e){out.fetch_error=String(e.message||e)}
  res.status(200).json(out);
};
