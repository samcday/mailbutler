FROM kaze/rubydev:latest
MAINTAINER Sam Day <me@samcday.com.au>

RUN apt-get install -y libsqlite3-dev

ADD gemrc /.gemrc

RUN gem install mailcatcher

EXPOSE 25:25
EXPOSE 80:80
ENTRYPOINT ["mailcatcher", "-f", "--smtp-port", "25", "--http-port", "80", "--http-ip", "0.0.0.0", "--smtp-ip", "0.0.0.0"]
